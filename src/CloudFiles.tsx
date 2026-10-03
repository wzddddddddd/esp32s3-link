import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudDevice } from './cloud/client';
import { child, FilesGateway, save, type Entry, type Command } from './cloud/files';
import { formatSize } from './demo';
import './files.css';

interface FolderHandle { kind: 'directory'; name: string; values(): AsyncIterable<FolderHandle | { kind: 'file'; name: string; getFile(): Promise<File> }> }
export default function CloudFiles({ client, devices }: { client: SupabaseClient; devices: CloudDevice[] }) {
  const [device, setDevice] = useState(devices[0]?.id || '');
  const [path, setPath] = useState('/'), [entries, setEntries] = useState<Entry[]>([]);
  const [jobs, setJobs] = useState<Command[]>([]), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [musicStatus, setMusicStatus] = useState('尚未读取'), [volume, setVolume] = useState(60);
  async function music(op: string, path = '/', args: Record<string, unknown> = {}) { await run(async g => { const accepted = await g.command(op, path, args); const state = op === 'music.status' ? accepted : await g.command('music.status', '/'); setMusicStatus(`${state.state} · ${state.path || ''} · ${state.position_ms || 0} ms`); }); }
  const active = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (!device && devices.length) setDevice(devices[0].id); }, [device, devices]);
  useEffect(() => {
    let alive = true;
    async function refresh() {
      if (!device) return;
      const r = await client.from('link_commands').select('id,op,path,status,error,result').eq('device_id', device).order('created_at', { ascending: false }).limit(30);
      if (alive) { if (r.error) setError('请先部署文件传输 SQL 和 device-gateway：' + r.error.message); else setJobs(r.data as Command[]); }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [client, device]);
  async function run(action: (g: FilesGateway) => Promise<void>) {
    if (active.current || !device) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setMessage('正在提交…');
    try { await action(new FilesGateway(client, device, controller.signal, text => { if(!controller.signal.aborted) setMessage(text); })); controller.signal.throwIfAborted(); setMessage('设备已返回结果；播放命令以实际状态为准'); }
    catch(e) { if(!controller.signal.aborted) setError(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)); }
    finally { if(active.current === controller) { active.current = null; setBusy(false); } }
  }
  function list(target: string) { void run(async g => { const items = await g.list(target); setPath(target); setEntries(items); }); }
  async function uploadFiles(files: File[], folder: boolean) {
    await run(async g => {
      const created = new Set<string>();
      if (files.length > 10000) throw new Error('一次最多 10000 项');
      for (const file of files) {
        const parts = (folder ? file.webkitRelativePath : file.name).split('/');
        if(parts.length > 17) throw new Error('目录超过 16 层');
        let parent = path;
        for (const part of parts.slice(0, -1)) { parent = child(parent, part); if(!created.has(parent)) { await g.command('mkdir', parent); created.add(parent); } }
        await g.put(file, child(parent, parts.at(-1)!), overwrite);
      }
    });
  }
  async function uploadFolder() {
    const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FolderHandle> }).showDirectoryPicker;
    if (!picker) { folderInput.current?.click(); return; }
    try {
      const tree = await picker();
      await run(async g => {
        let count = 0;
        const walk = async (folder: FolderHandle, parent: string, depth: number) => {
          if(depth > 16 || ++count > 10000) throw new Error('目录过深或超过 10000 项');
          const target = child(parent, folder.name); await g.command('mkdir', target);
          for await (const item of folder.values()) {
            if(item.kind === 'directory') await walk(item, target, depth + 1);
            else { if(++count > 10000) throw new Error('目录超过 10000 项'); await g.put(await item.getFile(), child(target, item.name), overwrite); }
          }
        };
        await walk(tree, path, 0);
      });
    } catch(e) { if(!(e instanceof DOMException && e.name === 'AbortError')) setError(String(e)); }
  }
  const ready = !!device && !busy;
  return <section className="file-manager">
    <h2>远程音乐</h2>
    <p>控制设备扬声器。播放指令返回后进入队列，点“实际状态”读取当前结果。</p>
    <div className="file-toolbar"><button disabled={!ready} onClick={() => list('/music')}>全部音乐</button>
      <button disabled={!ready} onClick={() => void music('music.pause')}>暂停</button>
      <button disabled={!ready} onClick={() => void music('music.resume')}>继续</button>
      <button disabled={!ready} onClick={() => void music('music.stop')}>停止</button>
      <button disabled={!ready} onClick={() => void music('music.status')}>实际状态</button>
      <label>音量 <input type="number" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))}/></label>
      <button disabled={!ready || !Number.isInteger(volume) || volume < 0 || volume > 100} onClick={() => void music('music.volume', '/', {volume})}>设置音量</button>
    </div><p>{musicStatus}</p>
    <p>通过现有云端管理 SD 卡。设备需要打开 Wi-Fi 应用、连接 Wi-Fi；大文件推荐 Wi-Fi，BLE 可用于配网和近距离传输。</p>
    <label>目标设备 <select disabled={busy} value={device} onChange={e => { setDevice(e.target.value); setPath('/'); setEntries([]); setMusicStatus('尚未读取'); }}>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <div className="file-toolbar"><strong>SD 卡 {path}</strong><button disabled={!ready || path === '/'} onClick={() => list(path.substring(0, path.lastIndexOf('/')) || '/')}>上一级</button><button disabled={!ready} onClick={() => list(path)}>刷新目录</button></div>
    <div className="file-toolbar"><input aria-label="新目录名称" placeholder="新目录名称" value={name} onChange={e => setName(e.target.value)} /><button disabled={!ready || !name} onClick={() => void run(async g => { await g.command('mkdir', child(path, name)); setEntries(await g.list(path)); setName(''); })}>创建目录</button></div>
    <div className="file-toolbar">
      <button disabled={!ready} onClick={() => input.current?.click()}>下发文件到此目录</button>
      <button disabled={!ready} onClick={() => void uploadFolder()}>下发整个目录</button>
      <button disabled={!ready} onClick={() => void run(async g => save(await g.zip(path), (path.split('/').pop() || 'sdcard') + '.zip'))}>接收此目录 ZIP</button>
      <label><input type="checkbox" disabled={busy} checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />允许覆盖 SD 同名文件</label>
    </div>
    <input hidden type="file" multiple ref={input} onChange={e => { void uploadFiles(Array.from(e.target.files || []), false); e.target.value = ''; }} />
    <input hidden type="file" multiple ref={folderInput} {...({ webkitdirectory: '' } as Record<string, string>)} onChange={e => { void uploadFiles(Array.from(e.target.files || []), true); e.target.value = ''; }} />
    <p className="file-help">单文件 ≤ 50 MiB；目录下载 ≤ 150 MiB，保留层级和空目录。Chrome / Edge 的目录选择支持下发空目录，其他浏览器回退选择器只提供非空目录。操作期间保持此页面打开，目录变化后请刷新。</p>
    {busy && <button onClick={() => { active.current?.abort(); setMessage('已停止等待和后续任务；设备已领取的任务可能继续，请看记录。'); }}>停止后续任务</button>}
    <p role="status">{message}</p>{error && <p role="alert" className="cloud-error">{error}</p>}
    <div className="file-list">{entries.map(entry => <div key={entry.name}><span>{entry.directory ? '目录' : '文件'} · {entry.name}</span><span>{entry.directory ? '' : formatSize(entry.size)}</span>{!entry.directory && path === '/music' && /\.mp3$/i.test(entry.name) && <button disabled={!ready} onClick={() => void music('music.play', child(path, entry.name))}>播放</button>}{!entry.directory && <button disabled={!ready} onClick={() => { if(window.confirm(`删除设备文件 ${entry.name}？`)) void run(async g => { await g.command('delete', child(path, entry.name)); setEntries(await g.list(path)); }); }}>删除</button>}{entry.directory && <button disabled={!ready} onClick={() => list(child(path, entry.name))}>打开</button>}<button disabled={!ready} onClick={() => void run(async g => { const p = child(path, entry.name); save(entry.directory ? await g.zip(p) : await g.get(p), entry.name + (entry.directory ? '.zip' : '')); })}>接收到电脑{entry.directory ? ' ZIP' : ''}</button></div>)}</div>
    <h2>最近文件任务</h2><p>离线时显示等待。停止浏览器等待不会撤销设备已经完成的文件。</p>
    <div className="file-list">{jobs.map(job => <div key={job.id}><span>{job.op} · {job.path}</span><span>{({ waiting: '等待联网领取', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' } as Record<string,string>)[job.status]} {job.error}</span>{job.status === 'waiting' && <button disabled={busy} onClick={() => void run(async () => { const r = await client.rpc('link_cancel_command', { p_id: job.id }); if(r.error) throw r.error; })}>取消排队</button>}{job.op === 'get' && job.status === 'completed' && <button disabled={!ready} onClick={() => void run(async g => save(await g.resource(String(job.result?.resource_id)), job.path.split('/').pop() || 'file'))}>下载已上传文件</button>}</div>)}</div>
  </section>;
}
