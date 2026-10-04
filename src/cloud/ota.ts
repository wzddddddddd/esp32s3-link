import type { SupabaseClient } from '@supabase/supabase-js';
import type { CloudDevice, CloudResource } from './client';
import { deviceOnline, OFFLINE_MESSAGE } from './presence';
import { inspectMainFirmware } from '../../supabase/functions/_shared/firmware';

export interface OtaSnapshot {
  mode?: 'main' | 'recovery'; target_role?: string; phase: string; job?: string; source?: string;
  received?: number; total?: number; active?: boolean; main_dirty?: boolean; can_return?: boolean;
  return_pending?: boolean; accepted?: boolean; sha256?: string; error_detail?: string; message?: string;
}
export const phaseLabels: Record<string, string> = { ready: '等待升级', handoff: '切换恢复程序',
  receiving: '下载并写入', downloading: '下载并写入', verifying: '校验镜像', verified: '镜像校验通过',
  error: '升级失败，停留恢复程序', cancelled: '升级已取消', idle: '等待升级' };
export function otaSnapshot(result: Record<string, unknown>): OtaSnapshot {
  const value = result.status ?? result.ota ?? result;
  if (!value || typeof value !== 'object' || typeof (value as OtaSnapshot).phase !== 'string') throw new Error('设备 OTA 状态格式无效');
  return value as OtaSnapshot;
}
export function verifiedFor(status: OtaSnapshot, expected: {job: string; size: number; sha256: string}) {
  return status.phase === 'verified' && status.active === false && status.main_dirty === false
    && status.job === expected.job && status.received === expected.size && status.total === expected.size
    && status.sha256 === expected.sha256;
}
export function canReturn(status?: OtaSnapshot | null) {
  return status?.can_return === true && status.main_dirty === false && status.active === false && !status.return_pending;
}
function check(signal: AbortSignal) { signal.throwIfAborted(); }
export async function pause(ms: number, signal: AbortSignal) {
  check(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function uploadMainFirmware(client: SupabaseClient, file: File, signal: AbortSignal,
    progress: (text: string) => void): Promise<{resource: string; firmware: Awaited<ReturnType<typeof inspectMainFirmware>>}> {
  if (!file.name.toLowerCase().endsWith('.bin') || new TextEncoder().encode(file.name).length > 120) throw new Error('请选择名称不超过 120 字节的主程序 BIN');
  progress('检查主应用镜像与 SHA-256');
  const bytes = new Uint8Array(await file.arrayBuffer()); check(signal);
  const firmware = await inspectMainFirmware(bytes); check(signal);
  const auth = await client.auth.getUser(); check(signal);
  if (auth.error || !auth.data.user) throw new Error('请先登录');
  const path = `${auth.data.user.id}/${crypto.randomUUID()}/payload`;
  progress('上传主固件到私有存储');
  const upload = await client.storage.from('link-resources').upload(path,
    new Blob([bytes.slice()], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false });
  if (upload.error) throw upload.error;
  check(signal);
  const registered = await client.rpc('link_register_resource', { p_path: path, p_name: file.name,
    p_kind: 'firmware', p_sha256: firmware.sha256 }).abortSignal(signal);
  if (registered.error) {
    void client.storage.from('link-resources').remove([path]);
    throw registered.error;
  }
  if (typeof registered.data !== 'string') throw new Error('云端未返回固件资源编号');
  return { resource: registered.data, firmware };
}

export class OtaGateway {
  constructor(private client: SupabaseClient, readonly deviceId: string, private signal: AbortSignal,
    private progress: (text: string) => void, private observed: (status: OtaSnapshot) => void = () => {}) {}
  async device() {
    check(this.signal);
    const result = await this.client.from('link_devices').select('*').eq('id', this.deviceId).abortSignal(this.signal).single();
    check(this.signal);
    if (result.error) throw result.error;
    return result.data as CloudDevice;
  }
  async command(op: string, args: Record<string, unknown> = {}, resource: string | null = null) {
    const device = await this.device();
    if (!deviceOnline(device) || !navigator.onLine) throw new Error(OFFLINE_MESSAGE);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(45000)]);
    const queued = await this.client.rpc('link_queue_ota', { p_device_id: this.deviceId, p_op: op,
      p_args: args, p_resource_id: resource }).abortSignal(signal);
    check(signal);
    if (queued.error) throw queued.error;
    if (typeof queued.data !== 'string') throw new Error('云端未返回 OTA 命令编号');
    while (true) {
      const result = await this.client.from('link_commands').select('*').eq('id', queued.data).abortSignal(signal).single();
      check(signal);
      if (result.error) throw result.error;
      if (result.data.status === 'completed') return result.data.result as Record<string, unknown>;
      if (['failed', 'cancelled'].includes(result.data.status)) throw new Error(result.data.error || 'OTA 命令已取消');
      await pause(400, signal);
    }
  }
  async waitRecovery() {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const device = await this.device();
      if (device.firmware_mode === 'recovery' && deviceOnline(device)) return device;
      this.progress('已请求切换，等待恢复程序重新连接 Wi-Fi');
      await pause(1000, this.signal);
    }
    throw new Error('恢复程序尚未重新上线。请检查设备屏幕、Wi-Fi 与设备凭证；未发送写入任务。');
  }
  async install(resource: CloudResource, job = crypto.randomUUID()) {
    let device = await this.device();
    if (device.firmware_mode !== 'recovery') {
      this.progress('请求主程序切换到 OTA 恢复程序');
      const entered = await this.command('ota.enter', { job, target_role: 'main' });
      if (entered.accepted !== true && otaSnapshot(entered).phase !== 'handoff') throw new Error('设备未确认进入恢复程序');
      device = await this.waitRecovery();
    }
    if (device.ota?.active) throw new Error('设备正在执行升级，请先等待或取消');
    this.progress('恢复程序已上线，发送主固件写入请求');
    const accepted = await this.command('ota.install', { job, target_role: 'main' }, resource.id);
    if (accepted.accepted !== true) throw new Error('恢复程序未确认启动写入');
    // A completed command acknowledges acceptance. Only the actual recovery
    // snapshot, with the same job, size and hash, confirms flash verification.
    this.progress('写入请求已接受，等待真实下载、擦写与校验进度');
    const until = Date.now() + 15 * 60 * 1000;
    while (Date.now() < until) {
      device = await this.device();
      if (device.firmware_mode !== 'recovery' || !deviceOnline(device)) {
        this.progress('升级期间连接暂时中断，等待恢复程序上线；不会重复下发写入');
        await pause(1000, this.signal); continue;
      }
      const status = otaSnapshot(await this.command('ota.status', { job })); this.observed(status);
      if (verifiedFor(status, { job, size: resource.size_bytes, sha256: resource.sha256 })) return status;
      if (status.job === job && ['error', 'cancelled'].includes(status.phase)) throw new Error(status.error_detail || status.message || '升级失败或取消，设备保留在恢复程序');
      if (status.phase === 'verified' && status.job === job) throw new Error('设备回报的字节或 SHA-256 与目标固件不一致，不能确认升级成功');
      await pause(1200, this.signal);
    }
    throw new Error('升级观察超时。设备仍以真实状态为准；请重新读取 OTA 状态，勿重复启动写入。');
  }
  async returnMain(job?: string) {
    const device = await this.device();
    const status = otaSnapshot(await this.command('ota.status', job ? { job } : {})); this.observed(status);
    if (device.firmware_mode !== 'recovery' || !canReturn(status)) throw new Error('主镜像不完整或设备仍在写入，不能返回主程序');
    await this.command('ota.return', job ? { job } : {});
    this.progress('返回请求已确认，等待主程序重新上线');
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const next = await this.device();
      if (next.firmware_mode === 'main' && deviceOnline(next)) return next;
      await pause(1000, this.signal);
    }
    throw new Error('主程序尚未重新上线，请检查设备屏幕和连接。');
  }
}
