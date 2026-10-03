import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudDevice } from './cloud/client';
import { child, DirectoryPendingError, FilesGateway, save, type Entry, type Command, type DirectoryResume } from './cloud/files';
import { DirectoryReads, type PendingDirectory } from './cloud/directory-read';
import { DirectoryCache } from './cloud/directory-cache';
import { formatSize } from './demo';
import './media-workspace.css';
import StoragePanel from './StoragePanel';
import OfflineDialog from './OfflineDialog';
import { deviceOnline as isDeviceOnline, OFFLINE_MESSAGE, offlineError } from './cloud/presence';
import { usePresenceClock } from './cloud/usePresenceClock';
import MediaDirectory, { mediaIcons } from './MediaDirectory';
import { mediaCategories as categories, type MediaCategory } from './media';
import { CircuitBoard, HardDrive, ChevronDown, Music2, Play, Pause, Square, RefreshCw, Volume2, FolderOpen, ArrowUp, Search, X, Upload, Folder, FolderUp, Plus, Download, History } from 'lucide-react';

interface FolderHandle { kind: 'directory'; name: string; values(): AsyncIterable<FolderHandle | { kind: 'file'; name: string; getFile(): Promise<File> }> }
export default function CloudFiles({ client, devices, categoryRoot = '/music', onCategoryChange, onBusyChange }: { client: SupabaseClient; devices: CloudDevice[]; categoryRoot?: string; onCategoryChange?: (root: string) => void; onBusyChange?: (busy: boolean) => void }) {
  const [device, setDevice] = useState(devices[0]?.id || '');
  const now = usePresenceClock();
  const [offlinePopup, setOfflinePopup] = useState(false);
  const latestDevices = useRef(devices); latestDevices.current = devices;
  const connected = () => navigator.onLine && isDeviceOnline(latestDevices.current.find(item => item.id === device));
  const deviceOnline = navigator.onLine && isDeviceOnline(devices.find(item => item.id === device), now);
  function requireConnection() {
    if (connected()) return true;
    setOfflinePopup(true); setError(OFFLINE_MESSAGE); return false;
  }
  const [category, setCategory] = useState<MediaCategory>(categories.find(item => item.root === categoryRoot) ?? categories[0]);
  const [search, setSearch] = useState('');
  const [path, setPath] = useState(categoryRoot), [entries, setEntries] = useState<Entry[]>([]);
  const [directoryState, setDirectoryState] = useState<'idle' | 'loading' | 'waiting' | 'partial' | 'complete'>('idle');
  const directoryReads = useRef(new DirectoryReads());
  const directoryCache = useRef(new DirectoryCache());
  const [waitingDirectory, setWaitingDirectory] = useState<PendingDirectory | null>(null);
  const [moreDirectory, setMoreDirectory] = useState<{ request: number; path: string; resume: DirectoryResume } | null>(null);
  const [jobs, setJobs] = useState<Command[]>([]), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [musicStatus, setMusicStatus] = useState('尚未读取'), [volume, setVolume] = useState(60);
  const musicObservation = useRef<AbortController | null>(null);
  function showMusicState(state: Record<string, unknown>) {
    const label = ({Playing:'正在播放',Paused:'已暂停',Stopped:'已停止',Opening:'正在打开',Buffering:'正在缓冲',Finished:'播放结束',Error:'播放失败'} as Record<string,string>)[String(state.state)] || String(state.state);
    setMusicStatus(`${label} · ${state.path || ''} · ${state.position_ms || 0} ms`);
    if (state.state === 'Error') throw new Error(state.error === 257 ? '设备播放器内存不足。播放指令已收到，但音乐没有开始播放。' : `设备播放失败（错误 ${state.error}），请检查设备日志。`);
  }
  async function music(op: string, path = '/', args: Record<string, unknown> = {}) {
    musicObservation.current?.abort();
    await run(async g => {
      const accepted = await g.command(op, path, args);
      if (op === 'music.status') { showMusicState(accepted); return '设备播放状态已更新。'; }
      setMusicStatus(`设备已接收指令${path === '/' ? '' : ` · ${path}`}，正在确认实际状态…`);
      // Observe actual playback independently, so a second cloud round trip
      // never locks the controls after the device accepted a command.
      const observation = new AbortController(); musicObservation.current = observation;
      const observer = new FilesGateway(client, device, observation.signal, () => {}, connected);
      void observer.command('music.status', '/').then(state => {
        if (!observation.signal.aborted) showMusicState(state);
      }).catch(e => { if (!observation.signal.aborted) setError(String(e instanceof Error ? e.message : e)); });
      return '设备已接收指令，实际播放状态会自动更新。';
    }, true);
  }
  const active = useRef<AbortController | null>(null), input = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null), directoryPanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (deviceOnline) return;
    const interrupted = !!active.current || !!directoryReads.current.pending;
    active.current?.abort(new Error(OFFLINE_MESSAGE)); musicObservation.current?.abort();
    const pending = directoryReads.current.pending;
    directoryReads.current.begin(); setWaitingDirectory(null); setMoreDirectory(null);
    directoryCache.current.invalidate(device);
    setDirectoryState(current => current === 'waiting' || current === 'loading' ? 'idle' : current);
    if (pending) void client.rpc('link_cancel_command', { p_id: pending.command.id }).abortSignal(AbortSignal.timeout(5000)).then(() => {}, () => {});
    if (interrupted) { setError(OFFLINE_MESSAGE); setMessage('设备已断开，本次等待已停止。'); }
  }, [deviceOnline, device, client]);
  useEffect(() => () => { directoryReads.current.begin(); active.current?.abort(); musicObservation.current?.abort(); }, []);
  useEffect(() => {
    musicObservation.current?.abort(); active.current?.abort();
    directoryReads.current.begin(); setWaitingDirectory(null); setMoreDirectory(null);
    setEntries([]); setDirectoryState('idle'); setMusicStatus('尚未读取');
  }, [device]);
  useEffect(() => { if (!device && devices.length) setDevice(devices[0].id); }, [device, devices]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    const item = categories.find(value => value.root === categoryRoot);
    if (item && item.root !== category.root && !active.current) chooseCategory(item);
  }, [categoryRoot]);
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
    // Keep one page-level subscription alive between button clicks. Supabase
    // otherwise disconnects its WebSocket when the last command channel leaves.
    let subscribed = false;
    const channel = device ? client.channel(`device-files-${device}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'link_commands', filter: `device_id=eq.${device}` }, () => void refresh())
      .subscribe(status => { subscribed = status === 'SUBSCRIBED'; if (subscribed) void refresh(); }) : null;
    void refresh();
    const fallback = setInterval(() => { if (!subscribed) void refresh(); }, 3000);
    const safety = setInterval(() => { if (subscribed) void refresh(); }, 15000);
    return () => {
      alive = false; observation.abort(); clearInterval(fallback); clearInterval(safety);
      if (channel) void client.removeChannel(channel).catch(() => {});
    };
  }, [client, device]);
  function discardDirectory() {
    const previous = directoryReads.current.pending;
    const request = directoryReads.current.begin();
    setWaitingDirectory(null);
    setMoreDirectory(null);
    if (previous) {
      setDirectoryState(previous.command.entries.length ? 'partial' : 'idle');
      void client.rpc('link_cancel_command', { p_id: previous.command.id }).abortSignal(AbortSignal.timeout(5000)).then(() => {}, () => {});
    }
    return request;
  }
  async function run(action: (g: FilesGateway) => Promise<void | string>, preserveDirectory = false) {
    if (device && !requireConnection()) return;
    if (active.current || !device) return;
    if (!preserveDirectory) { discardDirectory(); directoryCache.current.invalidate(device); }
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setMessage('正在提交…');
    try { const result = await action(new FilesGateway(client, device, controller.signal, text => { if(!controller.signal.aborted) setMessage(text); }, connected)); controller.signal.throwIfAborted(); setMessage(result || '设备已返回结果；播放命令以实际状态为准'); }
    catch(e) { if(!controller.signal.aborted) {
      if (offlineError(e)) { setOfflinePopup(true); setMessage('本次操作未完成。'); setError(OFFLINE_MESSAGE); }
      else if (e instanceof DirectoryPendingError && directoryReads.current.pending?.command.id === e.id) setMessage('设备返回较慢，目录请求仍在处理；结果返回后会自动显示。其他按钮已可使用。');
      else { setMessage('本次操作未完成，请查看下方提示和任务记录。'); setError(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)); }
    } }
    finally { if(active.current === controller) { active.current = null; setBusy(false); } }
  }
  function list(target: string, firstPage?: Record<string, unknown>, force = true) {
    if (device && !requireConnection()) return;
    if (active.current || !device) return;
    if (category.root !== '/' && target !== category.root && !target.startsWith(category.root + '/')) {
      const next = categories.find(item => item.root !== '/' && (target === item.root || target.startsWith(item.root + '/'))) ?? categories.at(-1)!;
      setCategory(next);
      onCategoryChange?.(next.root);
      setSearch('');
    }
    const pending = directoryReads.current.pending;
    if (!firstPage && pending?.command.device === device && pending.command.path === target) {
      setMessage('这个目录请求仍在处理，返回后会自动显示；无需重复提交。');
      directoryPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const request = discardDirectory();
    const cached = !force && !firstPage ? directoryCache.current.get(device, target) : undefined;
    if (cached) {
      setPath(target); setEntries(cached.entries); setDirectoryState(cached.complete ? 'complete' : 'partial');
      setMoreDirectory(cached.complete ? null : { request, path: target, resume: { cursor: cached.cursor, entries: cached.entries } });
      setMessage('显示最近 30 秒内读取的目录。点击刷新可重新读取设备。'); setError('');
      return;
    }
    readDirectory(target, firstPage, undefined, request);
  }
  function chooseCategory(item: MediaCategory) {
    if (active.current) return;
    setCategory(item); setSearch(''); onCategoryChange?.(item.root);
    if (device) list(item.root, undefined, false);
    else { setPath(item.root); setEntries([]); setDirectoryState('idle'); }
  }
  function readDirectory(target: string, firstPage: Record<string, unknown> | undefined, resume: DirectoryResume | undefined, request: number) {
    if (!directoryReads.current.current(request)) return;
    void run(async g => {
      setMoreDirectory(null);
      setPath(target); setEntries(resume?.entries ?? []); setDirectoryState(resume?.entries.length ? 'partial' : 'loading');
      try {
        const items = await g.list(target, (page, complete, cursor) => { if (directoryReads.current.current(request)) {
          setEntries(page); setDirectoryState(complete ? 'complete' : 'partial');
          directoryCache.current.put(device, target, page, complete, cursor);
          setMoreDirectory(complete ? null : { request, path: target, resume: { cursor, entries: page } });
        } }, firstPage, resume, 1);
        return `${target} 目录已显示，共 ${items.length} 项。`;
      } catch (e) {
        if (e instanceof DirectoryPendingError && directoryReads.current.current(request)) {
          directoryReads.current.defer(request, e);
          setWaitingDirectory(directoryReads.current.pending);
          setDirectoryState(e.entries.length ? 'partial' : 'waiting');
        } else if (resume?.entries.length && directoryReads.current.current(request)) {
          setMoreDirectory({ request, path: target, resume });
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
    if (!requireConnection()) return;
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
  const visibleEntries = entries.filter(entry => entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selectedDevice = devices.find(d => d.id === device);
  const CategoryIcon = mediaIcons[category.kind];
  const sd = selectedDevice?.storage?.sd;
  const total = sd?.status === 'ready' ? sd.total : selectedDevice?.capacity_bytes || 0;
  const used = sd?.status === 'ready' ? sd.used || 0 : selectedDevice?.used_bytes || 0;
  return <section className={`media-workspace theme-${category.kind}`}>
    <OfflineDialog open={offlinePopup} onClose={() => setOfflinePopup(false)} />
    <div className="media-device-bar">
      <div className="media-device-select"><span className="media-device-icon"><CircuitBoard size={23} /></span><label>当前设备<select aria-label="目标设备" disabled={busy} value={device} onChange={e => { discardDirectory(); musicObservation.current?.abort(); setDevice(e.target.value); setPath(category.root); setEntries([]); setDirectoryState('idle'); setMusicStatus('尚未读取'); }}>{!devices.length && <option value="">请先登记设备</option>}{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label></div>
      <span className={`media-connection ${deviceOnline ? 'is-online' : ''}`}><span />{deviceOnline ? '设备在线' : 'Wi-Fi 未连接'}</span>
      <div className="media-sd-summary"><HardDrive size={18} /><div><span>{total ? `SD 卡剩余 ${formatSize(Math.max(0, total - used))}` : '等待 SD 卡容量回报'}</span>{total > 0 && <progress aria-label="SD 卡使用率" value={Math.min(used, total)} max={total} />}</div></div>
    </div>
    <details className="media-capacity"><summary><HardDrive size={15} />查看分区与运行内存<ChevronDown size={15} /></summary><StoragePanel storage={selectedDevice?.storage} /></details>
    {!onCategoryChange && <nav className="media-category-tabs" aria-label="设备资源分类">{categories.map(item => { const Icon = mediaIcons[item.kind]; return <button key={item.root} aria-pressed={category.root === item.root} disabled={!ready} onClick={() => chooseCategory(item)}><Icon size={17} />{item.label}</button>; })}</nav>}
    <div className="media-library">
      {musicDirectory && <section className="media-player" aria-label="设备音乐播放器"><div className="media-player-art"><Music2 size={35} strokeWidth={1.4} /><div className="media-wave" aria-hidden="true">{[14, 27, 18, 36, 24, 42, 30, 19, 33, 15].map((height, i) => <i key={i} style={{ height }} />)}</div></div><div className="media-player-content"><span>设备播放器</span><h2>音乐，随时在身边。</h2><p role="status">{musicStatus}</p><div className="media-player-controls"><button disabled={!ready} onClick={() => void music('music.resume')} title="继续播放" aria-label="继续播放"><Play size={17} fill="currentColor" /></button><button disabled={!ready} onClick={() => void music('music.pause')} title="暂停" aria-label="暂停播放"><Pause size={17} /></button><button disabled={!ready} onClick={() => void music('music.stop')} title="停止" aria-label="停止播放"><Square size={14} fill="currentColor" /></button><button disabled={!ready} onClick={() => void music('music.status')}><RefreshCw size={14} />查询状态</button></div><label className="media-volume"><Volume2 size={16} /><input aria-label="音量" type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))} /><span>{volume}%</span><button disabled={!ready} onClick={() => void music('music.volume', '/', { volume })}>应用</button></label></div></section>}
      <section className="media-directory" ref={directoryPanel} aria-label="设备目录">
        <div className="media-directory-heading"><div><h2><CategoryIcon size={20} />{category.title}</h2><p>{entries.length ? `已载入 ${entries.length} 项${directoryState === 'partial' ? '，可继续加载' : ''}` : '内容直接读取自设备 SD 卡'}</p></div><button disabled={!ready} onClick={() => list(path)}><RefreshCw size={15} />{directoryState === 'idle' ? '获取目录' : '刷新'}</button></div>
        <div className="media-directory-tools"><div className="media-path"><FolderOpen size={16} /><span title={path}>{path}</span>{path !== category.root && <button disabled={!ready} onClick={() => list(path.substring(0, path.lastIndexOf('/')) || '/')}><ArrowUp size={14} />上一级</button>}</div><label className="media-search"><Search size={16} /><input aria-label="搜索当前目录" placeholder={`搜索${category.label === '全部文件' ? '文件' : category.label}名称`} value={search} onChange={e => setSearch(e.target.value)} />{search && <button onClick={() => setSearch('')} aria-label="清空搜索"><X size={14} /></button>}</label></div>
        <MediaDirectory category={category} entries={visibleEntries} path={path} ready={ready} state={directoryState} searching={!!search} onRefresh={() => list(path)} onOpen={entry => list(child(path, entry.name))} onPlay={entry => void music('music.play', child(path, entry.name))} onReceive={entry => void run(async g => { const p = child(path, entry.name); save(entry.directory ? await g.zip(p) : await g.get(p), entry.name + (entry.directory ? '.zip' : '')); })} onDelete={entry => { if (window.confirm(`删除设备文件 ${entry.name}？`)) void run(async g => { await g.command('delete', child(path, entry.name)); setEntries(await g.list(path)); }); }} />
        {moreDirectory && <div className="media-load-more"><button disabled={!ready} onClick={() => readDirectory(moreDirectory.path, undefined, moreDirectory.resume, moreDirectory.request)}>加载更多文件<ChevronDown size={15} /></button></div>}
      </section>
      {(message || error || busy || waitingDirectory) && <section className="media-feedback" aria-live="polite">{message && <p role="status">{busy && <RefreshCw className="media-spinner" size={15} />}{message}</p>}{error && <p role="alert" className="cloud-error">{error}</p>}{busy && <button onClick={() => { discardDirectory(); active.current?.abort(); setDirectoryState(current => current === 'loading' ? 'idle' : current); setMessage('已停止等待和后续任务；设备已领取的任务可能继续，请看记录。'); }}>停止后续任务</button>}{waitingDirectory && <p>正在等待 {waitingDirectory.command.path}<button disabled={busy} onClick={() => { discardDirectory(); setMessage('已取消目录结果的自动显示。'); }}>取消等待</button></p>}</section>}
    </div>
    <aside className="media-tools">
      <section className="media-send-panel"><div className="media-aside-heading"><Upload size={19} /><h2>发送到设备</h2></div><p>将电脑里的{category.label === '全部文件' ? '文件' : category.label}存到当前目录</p><button className="media-upload-zone" disabled={!ready} onClick={() => { if (requireConnection()) input.current?.click(); }}><span><Upload size={24} /></span><strong>选择{category.kind === 'file' ? '' : category.label}文件</strong><small>{category.format} · 单文件 ≤ 50 MiB</small></button><div className="media-upload-target"><Folder size={15} /><span title={path}>{path}</span></div><button className="media-folder-send" disabled={!ready} onClick={() => void uploadFolder()}><FolderUp size={16} />发送整个文件夹</button><label className="media-overwrite"><input type="checkbox" disabled={busy} checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />覆盖设备上的同名文件</label><p className="media-format-note">{category.kind === 'video' ? '设备支持指定编码的 AVI / MJPEG。MP4 上传后不会自动转码。' : category.kind === 'novel' ? '推荐 UTF-8 TXT。上传后在设备的小说页面阅读。' : category.kind === 'music' ? '设备播放支持 MP3。发送成功后可在歌曲旁点击播放。' : '文件保存成功后，可在设备中访问。'}</p></section>
      <section className="media-organize"><h2>文件夹工具</h2><label>新文件夹名称<input aria-label="新目录名称" placeholder="例如：我的收藏" value={name} onChange={e => setName(e.target.value)} /></label><button disabled={!ready || !name} onClick={() => void run(async g => { await g.command('mkdir', child(path, name)); setEntries(await g.list(path)); setName(''); })}><Plus size={15} />创建文件夹</button><button disabled={!ready} onClick={() => void run(async g => save(await g.zip(path), (path.split('/').pop() || 'sdcard') + '.zip'))}><Download size={15} />接收当前目录 ZIP</button><small>目录下载最多 150 MiB，保留原有文件层级。</small></section>
    </aside>
    <section className="media-activity"><div className="media-aside-heading"><History size={18} /><h2>最近操作</h2><span>{jobs.length ? `${jobs.length} 条记录` : '暂无记录'}</span></div><p>离线操作不入队。断开后取消未领取的任务，已执行的操作以设备回报为准。</p><div className="media-job-list">{jobs.length === 0 && <span className="media-no-jobs">发送文件或读取目录后，记录会显示在这里。</span>}{jobs.map(job => <div key={job.id} className="media-job"><span className={`media-job-dot ${job.status}`} /><div><strong>{({list:'读取目录', 'music.list':'读取音乐', put:'发送文件', get:'接收文件', mkdir:'创建文件夹', delete:'删除文件'} as Record<string, string>)[job.op] || job.op}</strong><span title={job.path}>{job.path}</span></div><span className={`media-job-state ${job.status}`}>{({ waiting: '等待设备', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[job.status]}{job.error && `：${job.error}`}</span>{(job.op === 'list' || job.op === 'music.list') && job.cursor === 0 && job.status === 'completed' && job.result && <button disabled={!ready} onClick={() => list(job.op === 'music.list' ? '/music' : job.path, job.result!)}>显示目录</button>}{job.status === 'waiting' && <button disabled={busy} onClick={() => void run(async () => { const r = await client.rpc('link_cancel_command', { p_id: job.id }); if (r.error) throw r.error; })}>取消排队</button>}{job.op === 'get' && job.status === 'completed' && <button disabled={!ready} onClick={() => void run(async g => save(await g.resource(String(job.result?.resource_id)), job.path.split('/').pop() || 'file'))}>下载文件</button>}</div>)}</div></section>
    <input hidden type="file" multiple accept={category.accept || undefined} ref={input} onChange={e => { void uploadFiles(Array.from(e.target.files || []), false); e.target.value = ''; }} />
    <input hidden type="file" multiple ref={folderInput} {...({ webkitdirectory: '' } as Record<string, string>)} onChange={e => { void uploadFiles(Array.from(e.target.files || []), true); e.target.value = ''; }} />
  </section>;
}
