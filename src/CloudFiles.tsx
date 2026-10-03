import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudDevice } from './cloud/client';
import { child, DirectoryPendingError, FilesGateway, save, type Entry, type Command, type DirectoryResume } from './cloud/files';
import { DirectoryReads, type PendingDirectory } from './cloud/directory-read';
import { formatSize } from './demo';
import './files.css';

interface FolderHandle { kind: 'directory'; name: string; values(): AsyncIterable<FolderHandle | { kind: 'file'; name: string; getFile(): Promise<File> }> }
export default function CloudFiles({ client, devices }: { client: SupabaseClient; devices: CloudDevice[] }) {
  const [device, setDevice] = useState(devices[0]?.id || '');
  const [path, setPath] = useState('/'), [entries, setEntries] = useState<Entry[]>([]);
  const [directoryState, setDirectoryState] = useState<'idle' | 'loading' | 'waiting' | 'partial' | 'complete'>('idle');
  const directoryReads = useRef(new DirectoryReads());
  const [waitingDirectory, setWaitingDirectory] = useState<PendingDirectory | null>(null);
  const [jobs, setJobs] = useState<Command[]>([]), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [musicStatus, setMusicStatus] = useState('尚未读取'), [volume, setVolume] = useState(60);
  async function music(op: string, path = '/', args: Record<string, unknown> = {}) {
    await run(async g => {
      const accepted = await g.command(op, path, args);
      const state = op === 'music.status' ? accepted : await g.command('music.status', '/');
      const label = ({Playing:'正在播放',Paused:'已暂停',Stopped:'已停止',Opening:'正在打开',Buffering:'正在缓冲',Finished:'播放结束',Error:'播放失败'} as Record<string,string>)[String(state.state)] || String(state.state);
      setMusicStatus(`${label} · ${state.path || ''} · ${state.position_ms || 0} ms`);
      if (state.state === 'Error') throw new Error(state.error === 257 ? '设备播放器内存不足。播放指令已收到，但音乐没有开始播放。' : `设备播放失败（错误 ${state.error}），请检查设备日志。`);
      return '设备播放状态已更新。';
    }, true);
  }
  const active = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null), directoryPanel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (directoryState !== 'idle') directoryPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [directoryState, entries]);
  useEffect(() => () => { directoryReads.current.begin(); active.current?.abort(); }, []);
  useEffect(() => { if (!device && devices.length) setDevice(devices[0].id); }, [device, devices]);
  useEffect(() => {
    let alive = true, refreshing = false;
    const observation = new AbortController();
    async function refresh() {
      if (!device || refreshing) return;
      refreshing = true;
      try {
        const signal = AbortSignal.any([observation.signal, AbortSignal.timeout(10000)]);
        const r = await client.from('link_commands').select('id,op,path,cursor,status,error,result').eq('device_id', device).order('created_at', { ascending: false }).limit(30).abortSignal(signal);
        if (!alive || r.error) return;
        const rows = r.data as Command[];
        setJobs(rows);
        const pending = directoryReads.current.pending;
        if (!pending || pending.command.device !== device || active.current) return;
        let job = rows.find(item => item.id === pending.command.id);
        if (!job) {
          const reply = await client.from('link_commands').select('id,op,path,cursor,status,error,result').eq('device_id', device).eq('id', pending.command.id).abortSignal(signal).single();
          if (reply.error) return;
          job = reply.data as Command;
        }
        if (!alive || active.current || directoryReads.current.match(device, job) !== pending) return;
        if (job.status === 'completed') {
          directoryReads.current.pending = null;
          setWaitingDirectory(null);
          readDirectory(pending.command.path, job.result ?? {}, { cursor: pending.command.cursor, entries: pending.command.entries }, pending.request);
        } else if (job.status === 'failed' || job.status === 'cancelled') {
          directoryReads.current.pending = null;
          setWaitingDirectory(null);
          setDirectoryState(pending.command.entries.length ? 'partial' : 'idle');
          setMessage('目录读取未完成。');
          setError(job.error || '目录任务已取消，请重新读取。');
        }
      } catch { /* Keep the pending ID and retry observation on the next refresh. */ }
      finally { refreshing = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { alive = false; observation.abort(); clearInterval(timer); };
  }, [client, device]);
  function discardDirectory() {
    const previous = directoryReads.current.pending;
    const request = directoryReads.current.begin();
    setWaitingDirectory(null);
    if (previous) {
      setDirectoryState(previous.command.entries.length ? 'partial' : 'idle');
      void client.rpc('link_cancel_command', { p_id: previous.command.id }).abortSignal(AbortSignal.timeout(5000)).then(() => {}, () => {});
    }
    return request;
  }
  async function run(action: (g: FilesGateway) => Promise<void | string>, preserveDirectory = false) {
    if (active.current || !device) return;
    if (!preserveDirectory) discardDirectory();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setMessage('正在提交…');
    try { const result = await action(new FilesGateway(client, device, controller.signal, text => { if(!controller.signal.aborted) setMessage(text); })); controller.signal.throwIfAborted(); setMessage(result || '设备已返回结果；播放命令以实际状态为准'); }
    catch(e) { if(!controller.signal.aborted) {
      if (e instanceof DirectoryPendingError && directoryReads.current.pending?.command.id === e.id) setMessage('设备返回较慢，目录请求仍在处理；结果返回后会自动显示。其他按钮已可使用。');
      else { setMessage('本次操作未完成，请查看下方提示和任务记录。'); setError(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)); }
    } }
    finally { if(active.current === controller) { active.current = null; setBusy(false); } }
  }
  function list(target: string, firstPage?: Record<string, unknown>) {
    if (active.current || !device) return;
    const pending = directoryReads.current.pending;
    if (!firstPage && pending?.command.device === device && pending.command.path === target) {
      setMessage('这个目录请求仍在处理，返回后会自动显示；无需重复提交。');
      directoryPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    readDirectory(target, firstPage, undefined, discardDirectory());
  }
  function readDirectory(target: string, firstPage: Record<string, unknown> | undefined, resume: DirectoryResume | undefined, request: number) {
    if (!directoryReads.current.current(request)) return;
    void run(async g => {
      setPath(target); setEntries(resume?.entries ?? []); setDirectoryState(resume?.entries.length ? 'partial' : 'loading');
      try {
        const items = await g.list(target, (page, complete) => { if (directoryReads.current.current(request)) { setEntries(page); setDirectoryState(complete ? 'complete' : 'partial'); } }, firstPage, resume);
        return `${target} 目录已显示，共 ${items.length} 项；点击歌曲旁的“播放”按钮。`;
      } catch (e) {
        if (e instanceof DirectoryPendingError && directoryReads.current.current(request)) {
          directoryReads.current.defer(request, e);
          setWaitingDirectory(directoryReads.current.pending);
          setDirectoryState(e.entries.length ? 'partial' : 'waiting');
        }
        throw e;
      } finally { if (directoryReads.current.current(request) && !directoryReads.current.pending) setDirectoryState(current => current === 'loading' ? 'idle' : current); }
    }, true);
  }
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
  const musicDirectory = path === '/music' || path.startsWith('/music/');
  return <section className="file-manager">
    <label>目标设备 <select disabled={busy} value={device} onChange={e => { discardDirectory(); setDevice(e.target.value); setPath('/'); setEntries([]); setDirectoryState('idle'); setMusicStatus('尚未读取'); }}>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <h2>远程音乐</h2>
    <p>点击“全部音乐”读取 SD 卡音乐目录，再点击歌曲旁的“播放”。</p>
    <div className="file-toolbar"><button disabled={!ready} onClick={() => list('/music')}>全部音乐</button>
      <button disabled={!ready} onClick={() => void music('music.pause')}>暂停</button>
      <button disabled={!ready} onClick={() => void music('music.resume')}>继续</button>
      <button disabled={!ready} onClick={() => void music('music.stop')}>停止</button>
      <button disabled={!ready} onClick={() => void music('music.status')}>实际状态</button>
      <label>音量 <input type="number" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))}/></label>
      <button disabled={!ready || !Number.isInteger(volume) || volume < 0 || volume > 100} onClick={() => void music('music.volume', '/', {volume})}>设置音量</button>
    </div><p className="file-help">播放状态：{musicStatus}</p>
    <div className="file-toolbar"><strong>{musicDirectory ? '音乐目录' : 'SD 卡目录'} {path}</strong><button disabled={!ready || path === '/'} onClick={() => list(path.substring(0, path.lastIndexOf('/')) || '/')}>上一级</button><button disabled={!ready} onClick={() => list(path)}>刷新目录</button></div>
    <p role="status">{message}</p>{error && <p role="alert" className="cloud-error">{error}</p>}
    {busy && <button onClick={() => { discardDirectory(); active.current?.abort(); setDirectoryState(current => current === 'loading' ? 'idle' : current); setMessage('已停止等待和后续任务；设备已领取的任务可能继续，请看记录。'); }}>停止后续任务</button>}
    {waitingDirectory && <p className="file-help">仍在等待 {waitingDirectory.command.path} 的目录结果。<button disabled={busy} onClick={() => { discardDirectory(); setMessage('已停止自动显示这次目录；设备已领取的任务可能继续，请看记录。'); }}>取消目录读取</button></p>}
    <div ref={directoryPanel} className="directory-panel" aria-label="设备目录">
      <p className="file-help">{directoryState === 'loading' ? '正在获取目录，设备返回后会在这里显示…' : directoryState === 'waiting' ? '设备返回较慢，目录请求仍在处理；结果返回后会自动显示。' : directoryState === 'partial' ? `已显示 ${entries.length} 项，目录尚未全部读取。` : directoryState === 'complete' ? `设备已返回 ${entries.length} 项` : '点击“全部音乐”或“刷新目录”读取设备文件。'}</p>
      {directoryState === 'complete' && entries.length === 0 && <p>此目录为空。</p>}
      <div className="file-list">{entries.map(entry => <div key={entry.name}><span>{entry.directory ? '目录' : '文件'} · {entry.name}</span><span>{entry.directory ? '' : formatSize(entry.size)}</span>{!entry.directory && musicDirectory && /\.mp3$/i.test(entry.name) && <button className="song-play" disabled={!ready} onClick={() => void music('music.play', child(path, entry.name))}>播放</button>}{!entry.directory && <button disabled={!ready} onClick={() => { if(window.confirm(`删除设备文件 ${entry.name}？`)) void run(async g => { await g.command('delete', child(path, entry.name)); setEntries(await g.list(path)); }); }}>删除</button>}{entry.directory && <button disabled={!ready} onClick={() => list(child(path, entry.name))}>打开</button>}<button disabled={!ready} onClick={() => void run(async g => { const p = child(path, entry.name); save(entry.directory ? await g.zip(p) : await g.get(p), entry.name + (entry.directory ? '.zip' : '')); })}>接收到电脑{entry.directory ? ' ZIP' : ''}</button></div>)}</div>
    </div>
    <h2>文件传输</h2>
    <div className="file-toolbar"><input aria-label="新目录名称" placeholder="新目录名称" value={name} onChange={e => setName(e.target.value)} /><button disabled={!ready || !name} onClick={() => void run(async g => { await g.command('mkdir', child(path, name)); setEntries(await g.list(path)); setName(''); })}>创建目录</button></div>
    <div className="file-toolbar">
      <button disabled={!ready} onClick={() => input.current?.click()}>下发文件到此目录</button>
      <button disabled={!ready} onClick={() => void uploadFolder()}>下发整个目录</button>
      <button disabled={!ready} onClick={() => void run(async g => save(await g.zip(path), (path.split('/').pop() || 'sdcard') + '.zip'))}>接收此目录 ZIP</button>
      <label><input type="checkbox" disabled={busy} checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />允许覆盖 SD 同名文件</label>
    </div>
    <input hidden type="file" multiple ref={input} onChange={e => { void uploadFiles(Array.from(e.target.files || []), false); e.target.value = ''; }} />
    <input hidden type="file" multiple ref={folderInput} {...({ webkitdirectory: '' } as Record<string, string>)} onChange={e => { void uploadFiles(Array.from(e.target.files || []), true); e.target.value = ''; }} />
    <p className="file-help">设备需要连接 Wi-Fi。单文件 ≤ 50 MiB；目录下载 ≤ 150 MiB，保留层级和空目录。Chrome / Edge 的目录选择支持下发空目录，其他浏览器回退选择器只提供非空目录。操作期间保持此页面打开，目录变化后请刷新。</p>
    <h2>最近文件任务</h2><p>离线时显示等待。停止浏览器等待不会撤销设备已经完成的文件。</p>
    <div className="file-list">{jobs.map(job => <div key={job.id}><span>{job.op} · {job.path}</span><span>{({ waiting: '等待联网领取', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' } as Record<string,string>)[job.status]} {job.error}</span>{(job.op === 'list' || job.op === 'music.list') && job.cursor === 0 && job.status === 'completed' && job.result && <button disabled={!ready} onClick={() => list(job.op === 'music.list' ? '/music' : job.path, job.result!)}>显示目录</button>}{job.status === 'waiting' && <button disabled={busy} onClick={() => void run(async () => { const r = await client.rpc('link_cancel_command', { p_id: job.id }); if(r.error) throw r.error; })}>取消排队</button>}{job.op === 'get' && job.status === 'completed' && <button disabled={!ready} onClick={() => void run(async g => save(await g.resource(String(job.result?.resource_id)), job.path.split('/').pop() || 'file'))}>下载已上传文件</button>}</div>)}</div>
  </section>;
}
