import type { SupabaseClient } from '@supabase/supabase-js';
import JSZip from 'jszip';

export interface Entry { name: string; size: number; directory: boolean }
export interface Command { id: string; op: string; path: string; cursor: number; status: string; error: string | null; result: Record<string, unknown> | null }
const MAX_FILE = 50 * 1024 * 1024;
export function child(parent: string, name: string) {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f:*?"<>|]/.test(name) || /[. ]$/.test(name)) throw new Error('文件名不受 SD 卡支持：' + name);
  const path = parent.replace(/\/$/, '') + '/' + name;
  if (new TextEncoder().encode(path).length > 240 || /^\/\.link(?:\/|$)/i.test(path)) throw new Error('路径过长或属于系统目录');
  return path;
}
export async function sha256(blob: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function check(signal: AbortSignal) { signal.throwIfAborted(); }
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    check(signal);
    const stop = () => { clearTimeout(timer); reject(new Error('已停止等待；已开始的设备任务可能继续执行，请查看记录')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1500);
    signal.addEventListener('abort', stop, { once: true });
  });
}
export class FilesGateway {
  constructor(private client: SupabaseClient, private device: string, private signal: AbortSignal, private progress: (message: string) => void) {}
  async command(op: string, path: string, extra: Record<string, unknown> = {}) {
    check(this.signal);
    const business = op.startsWith('music.') || op === 'delete' || op === 'capabilities';
    const transfer = op === 'put' || op === 'get';
    const timeoutMs = transfer ? 30 * 60 * 1000 : 90 * 1000;
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(new Error(transfer ? '文件传输等待超过 30 分钟，请查看任务记录。' : '设备 90 秒内未返回结果。请检查设备 Wi-Fi 云端状态或前面的任务，再重试。')), timeoutMs);
    let id: string | undefined;
    const started = Date.now();
    try {
      const queued = await this.client.rpc(business ? 'link_queue_remote' : 'link_queue_command', business ? { p_device_id: this.device, p_op: op, p_path: path, p_args: extra } : { p_device_id: this.device, p_op: op, p_path: path, ...extra }).abortSignal(signal);
      check(signal);
      if (queued.error) throw queued.error;
      id = String(queued.data);
      while (true) {
        check(signal);
        const reply = await this.client.from('link_commands').select('*').eq('id', id).abortSignal(signal).single();
        check(signal);
        if (reply.error) throw reply.error;
        const command = reply.data as Command;
        this.progress(`${path} · ${command.status === 'waiting' ? '已提交，等待设备领取（请保持设备 Wi-Fi 联网）' : command.status === 'running' ? '设备正在读取或执行，等待结果' : command.status === 'completed' ? '设备已返回结果' : command.status} · ${Math.floor((Date.now() - started) / 1000)} 秒`);
        if (command.status === 'completed') return command.result ?? {};
        if (command.status === 'failed' || command.status === 'cancelled') throw new Error(command.error || '任务已取消');
        await pause(signal);
      }
    } catch (error) {
      // Only unclaimed commands can be cancelled. A device already writing a
      // file must finish/abort safely; never claim a browser abort rolled it back.
      // Cleanup must not leave the page locked if the network is unavailable.
      if (id) void this.client.rpc('link_cancel_command', { p_id: id }).abortSignal(AbortSignal.timeout(5000)).then(() => {}, () => {});
      throw timeout.signal.aborted ? timeout.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  }
  async list(path: string, onPage?: (entries: Entry[], complete: boolean) => void, firstPage?: Record<string, unknown>): Promise<Entry[]> {
    const all: Entry[] = []; let cursor = 0;
    while (true) {
      check(this.signal);
      const r = firstPage ?? await this.command('list', path, { p_cursor: cursor });
      firstPage = undefined;
      check(this.signal);
      if (!Array.isArray(r.entries) || typeof r.end !== 'boolean') throw new Error('设备返回无效目录');
      for (const item of r.entries) {
        if (typeof item.name !== 'string' || typeof item.directory !== 'boolean' || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('设备目录项无效');
        child(path, item.name); all.push(item as Entry);
      }
      if (all.length > 10000) throw new Error('单目录超过 10000 项');
      if (!r.end && (!Number.isSafeInteger(r.cursor) || Number(r.cursor) <= cursor)) throw new Error('目录游标无效');
      onPage?.([...all], r.end);
      if (r.end) return all;
      cursor = Number(r.cursor);
    }
  }
  async put(file: File, path: string, overwrite: boolean) {
    check(this.signal);
    if (file.size > MAX_FILE || new TextEncoder().encode(file.name).length > 120) throw new Error('单文件最多 50 MiB，名称最多 120 UTF-8 字节');
    this.progress('校验并上传云端：' + path);
    const hash = await sha256(file); check(this.signal);
    const user = await this.client.auth.getUser();
    if (user.error || !user.data.user) throw new Error('请重新登录');
    const storage = `${user.data.user.id}/${crypto.randomUUID()}/payload`;
    const uploaded = await this.client.storage.from('link-resources').upload(storage, file, { contentType: 'application/octet-stream', upsert: false });
    if (uploaded.error) throw uploaded.error;
    const resource = await this.client.rpc('link_register_file', { p_path: storage, p_name: file.name, p_sha256: hash });
    if (resource.error) { await this.client.storage.from('link-resources').remove([storage]); throw resource.error; }
    await this.command('put', path, { p_resource_id: resource.data, p_overwrite: overwrite });
  }
  async get(path: string): Promise<Blob> {
    const result = await this.command('get', path);
    return this.resource(String(result.resource_id));
  }
  async resource(id: string): Promise<Blob> {
    check(this.signal);
    const r = await this.client.from('link_resources').select('storage_path,size_bytes,sha256').eq('id', id).single();
    if (r.error) throw r.error;
    if (r.data.size_bytes > MAX_FILE) throw new Error('文件超过 50 MiB');
    const signed = await this.client.storage.from('link-resources').createSignedUrl(r.data.storage_path, 300);
    if (signed.error) throw signed.error;
    const response = await fetch(signed.data.signedUrl, { signal: this.signal });
    if (!response.ok) throw new Error('云端下载失败');
    const blob = await response.blob();
    if (blob.size !== r.data.size_bytes || await sha256(blob) !== r.data.sha256) throw new Error('文件大小或 SHA-256 不一致');
    return blob;
  }
  async zip(path: string) {
    const zip = new JSZip(); let total = 0, count = 0;
    const walk = async (remote: string, relative: string, depth: number) => {
      if (depth > 16) throw new Error('目录深度超过 16 层');
      zip.folder(relative);
      for (const entry of await this.list(remote)) {
        if (++count > 10000) throw new Error('目录超过 10000 项');
        const next = child(remote, entry.name), target = relative + '/' + entry.name;
        if (entry.directory) await walk(next, target, depth + 1);
        else {
          if (entry.size > MAX_FILE || total + entry.size > 150 * 1024 * 1024) throw new Error('目录下载限 150 MiB、单文件限 50 MiB，请分批接收');
          const blob = await this.get(next); total += blob.size;
          if (total > 150 * 1024 * 1024) throw new Error('目录内容变化，已超过 150 MiB');
          zip.file(target, await blob.arrayBuffer());
        }
      }
    };
    await walk(path, path.split('/').pop() || 'sdcard', 0); check(this.signal);
    this.progress('所有文件已校验，正在打包 ZIP');
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }
}
export function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
