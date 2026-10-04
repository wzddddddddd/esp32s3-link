import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ArrowRight, CheckCircle2, Cpu, FileUp, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { CloudDevice, CloudResource } from './cloud/client';
import { canReturn, OtaGateway, otaSnapshot, phaseLabels, uploadMainFirmware, type OtaSnapshot } from './cloud/ota';
import { deviceOnline, offlineError } from './cloud/presence';
import { usePresenceClock } from './cloud/usePresenceClock';
import { formatSize } from './demo';
import OfflineDialog from './OfflineDialog';
import './ota.css';

const readable = (error: unknown) => {
  const text = error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重新读取设备状态';
  const errors: Record<string, string> = { OTA_NOT_SUPPORTED: '当前主程序尚未接入 OTA，请先通过串口安装支持 OTA 的主固件',
    DEVICE_BUSY: '设备正在执行其他任务，请先停止播放或等待传输结束', OTA_BUSY: '设备已经在执行升级，请读取当前进度',
    OTA_RECOVERY_REQUIRED: '请先进入 OTA 恢复程序', OTA_MAIN_DIRTY_OR_BUSY: '主固件尚未完整写入或正在升级，不能返回主程序',
    DEVICE_RECOVERY_MODE: '设备正在切换或运行恢复程序，请使用 OTA 页面' };
  return Object.entries(errors).find(([code]) => text.includes(code))?.[1] ?? text;
};
export default function CloudOta({ client, devices, resources, refresh, onBusyChange, blocked }: {
  client: SupabaseClient; devices: CloudDevice[]; resources: CloudResource[]; refresh: () => Promise<void>;
  onBusyChange: (busy: boolean) => void; blocked: boolean;
}) {
  const [target, setTarget] = useState(''), [resourceId, setResourceId] = useState('');
  const [status, setStatus] = useState<OtaSnapshot | null>(null), [message, setMessage] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [controlBusy, setControlBusy] = useState(false);
  const [offline, setOffline] = useState(false), [confirm, setConfirm] = useState(false);
  const abort = useRef<AbortController | null>(null), active = useRef(false), dialog = useRef<HTMLDialogElement>(null);
  const now = usePresenceClock();
  const device = devices.find(item => item.id === target), resource = resources.find(item => item.id === resourceId);
  const online = navigator.onLine && deviceOnline(device, now), recovery = device?.firmware_mode === 'recovery';
  const firmware = resources.filter(item => item.kind === 'firmware' && item.size_bytes <= 4 * 1024 * 1024);
  useEffect(() => { if (!target && devices[0]) setTarget(devices[0].id); }, [devices, target]);
  useEffect(() => { setStatus(device?.ota ?? null); }, [target, device?.ota]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { abort.current?.abort(); onBusyChange(false); }, [onBusyChange]);
  useEffect(() => { if (confirm) dialog.current?.showModal(); }, [confirm]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current || blocked) return;
    active.current = true; setBusy(true); setError('');
    const controller = new AbortController(); abort.current = controller;
    try { await action(controller.signal); }
    catch (e) { if (!controller.signal.aborted) { setError(readable(e)); if (offlineError(e)) setOffline(true); } }
    finally { active.current = false; setBusy(false); }
  }
  function requireOnline() { if (online) return true; setOffline(true); return false; }
  async function upload(file?: File) {
    if (!file) return;
    await run(async signal => {
      const saved = await uploadMainFirmware(client, file, signal, setMessage);
      await refresh(); setResourceId(saved.resource);
      setMessage(`主固件已上传：${saved.firmware.version || '未填写版本'}，${formatSize(saved.firmware.size)}。选择设备后开始升级。`);
    });
  }
  async function start() {
    setConfirm(false); if (!resource || !device || !requireOnline()) return;
    await run(async signal => {
      const gateway = new OtaGateway(client, device.id, signal, setMessage, setStatus);
      const verified = await gateway.install(resource); setStatus(verified);
      setMessage('主固件完整写入，字节与 SHA-256 校验通过。点击“返回主程序”完成启动。');
      await refresh();
    });
  }
  async function control(op: 'ota.status' | 'ota.cancel') {
    if (!device || controlBusy || !requireOnline()) return;
    setControlBusy(true); setError('');
    try {
      const gateway = new OtaGateway(client, device.id, AbortSignal.timeout(45000), setMessage, setStatus);
      const result = await gateway.command(op, status?.job ? { job: status.job } : {});
      if (op === 'ota.status') setStatus(otaSnapshot(result));
      else { setMessage('取消请求已确认；以设备后续状态为准，写过一部分的主固件不能启动。'); setStatus(otaSnapshot(await gateway.command('ota.status'))); }
      await refresh();
    } catch (e) { setError(readable(e)); if (offlineError(e)) setOffline(true); }
    finally { setControlBusy(false); }
  }
  async function returnMain() {
    if (!device || !requireOnline()) return;
    await run(async signal => {
      const main = await new OtaGateway(client, device.id, signal, setMessage, setStatus).returnMain(status?.job);
      setStatus(main.ota ?? null); await refresh(); setMessage('主程序已重新上线，可以继续使用音乐、视频和小说。');
    });
  }
  const received = status?.received ?? 0, total = status?.total ?? 0;
  return <div className="ota-workspace">
    <OfflineDialog open={offline} onClose={() => setOffline(false)} />
    <section className="ota-device-bar"><div><Cpu size={22} /><strong>升级主程序</strong><span>ESP32-S3</span></div>
      <label className="field">选择设备<select value={target} disabled={busy || blocked} onChange={event => { setTarget(event.target.value); setError(''); setMessage(''); }}>
        {!devices.length && <option value="">请先登记设备</option>}{devices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <span className={`status-pill ${online ? 'online' : ''}`}>{online ? 'Wi-Fi 已连接' : 'Wi-Fi 未连接'}</span>
    </section>
    <div className="ota-route" aria-label="升级流程">
      <div className={!recovery ? 'current' : ''}><span>1</span><strong>主程序</strong><small>发出升级请求</small></div><ArrowRight size={20} />
      <div className={recovery ? 'current' : ''}><span>2</span><strong>OTA 恢复程序</strong><small>下载、写入、校验</small></div><ArrowRight size={20} />
      <div><span>3</span><strong>返回主程序</strong><small>重新上线后继续使用</small></div>
    </div>
    <div className="ota-content"><section className="panel ota-input">
      <h2>选择主固件</h2><p className="muted">使用 display 工程的独立主应用 BIN，容量不超过 4 MiB。</p>
      <label className="ota-upload"><FileUp size={26} /><strong>上传主程序 BIN</strong><span>先检查芯片、程序角色与镜像校验，再保存到私有云端</span>
        <input type="file" accept=".bin" disabled={busy || blocked} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label>
      <label className="field">已上传的主固件<select value={resourceId} disabled={busy || blocked} onChange={event => setResourceId(event.target.value)}><option value="">请选择固件</option>{firmware.map(item => <option key={item.id} value={item.id}>{item.name} / {formatSize(item.size_bytes)}</option>)}</select></label>
      {resource && <dl className="details ota-file-detail"><div><dt>写入位置</dt><dd>主程序分区 / 4 MiB</dd></div><div><dt>文件大小</dt><dd>{formatSize(resource.size_bytes)}</dd></div><div><dt>SHA-256</dt><dd title={resource.sha256}>{resource.sha256.slice(0, 20)}…</dd></div></dl>}
      <button className="button primary" disabled={!resource || !device || busy || blocked || status?.active === true} onClick={() => { if (requireOnline()) setConfirm(true); }}><ShieldCheck size={17} />开始升级主程序</button>
      <p className="ota-help">升级失败或断电后保留在恢复程序。主固件只保留一份，写入失败后需重新升级才能启动。</p>
    </section><section className="panel ota-progress" aria-live="polite">
      <div className="section-heading"><h2>设备当前状态</h2><span className={`ota-mode ${recovery ? 'recovery' : ''}`}>{recovery ? '恢复程序模式' : '主程序模式'}</span></div>
      <div className="ota-phase"><CheckCircle2 size={27} /><strong>{status ? phaseLabels[status.phase] || status.phase : '等待设备回报'}</strong></div>
      {total > 0 ? <><progress max={total} value={Math.min(received, total)} aria-label="固件写入进度" /><div className="ota-byte-count"><span>{formatSize(received)} / {formatSize(total)}</span><strong>{Math.floor(received / total * 100)}%</strong></div></> : <p className="muted">写入请求接受后，显示设备回报的实际字节进度。</p>}
      {status?.job && <p className="ota-job">任务 {status.job}</p>}
      {status?.main_dirty && <div className="cloud-error">主固件不完整，当前不能返回主程序。请重新安装有效的主固件。</div>}
      {(status?.error_detail || status?.message) && <p>{status.error_detail || status.message}</p>}
      {message && <p className="inline-note" role="status">{message}</p>}{error && <div className="cloud-error" role="alert">{error}</div>}
      <div className="ota-controls"><button className="button" disabled={!device || controlBusy || blocked} onClick={() => void control('ota.status')}><RefreshCw size={15} />读取状态</button>
        <button className="button" disabled={!recovery || !status?.active || controlBusy || blocked} onClick={() => void control('ota.cancel')}><Square size={14} />取消升级</button>
        <button className="button primary" disabled={!recovery || !canReturn(status) || busy || blocked} onClick={() => void returnMain()}>返回主程序</button></div>
      <p className="ota-help">“请求已接受”只是开始写入。只有设备完成全部字节与 SHA-256 校验，才显示校验通过。</p>
    </section></div>
    <dialog className="modal ota-confirm" ref={dialog} onClose={() => setConfirm(false)}>{confirm && <><h2>确认升级主程序</h2><p>设备：{device?.name}</p><p>固件：{resource?.name} / {formatSize(resource?.size_bytes || 0)}</p><p className="muted">设备会切换到恢复程序，再写入主固件。请保持供电与 Wi-Fi 连接。恢复程序和 SD 卡内容保留。</p><div className="modal-actions"><button className="button" onClick={() => dialog.current?.close()}>取消</button><button className="button primary" onClick={() => { dialog.current?.close(); void start(); }}>确认开始升级</button></div></>}</dialog>
  </div>;
}
