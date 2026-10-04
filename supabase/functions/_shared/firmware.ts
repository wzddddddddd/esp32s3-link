/** The OTA channel accepts a complete main application image, never a merged flash image. */
export const MAIN_LIMIT = 4 * 1024 * 1024;
const hex = (data: ArrayBuffer) => Array.from(new Uint8Array(data), byte => byte.toString(16).padStart(2, '0')).join('');
export async function inspectMainFirmware(bytes: Uint8Array) {
  if (bytes.length < 288 || bytes.length > MAIN_LIMIT) throw new Error('主固件必须非空且不超过 4 MiB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0xe9 || bytes[1] < 1 || bytes[1] > 16 || view.getUint16(12, true) !== 9)
    throw new Error('请选择 ESP32-S3 主应用 BIN，不能使用合并烧录包');
  if ((bytes[3] >>> 4) !== 4 || view.getUint32(28, true) < 256 || view.getUint32(32, true) !== 0xabcd5432)
    throw new Error('固件描述或 16 MiB Flash 配置不匹配');
  const text = (offset: number) => new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset, offset + 32).filter((_, index, data) => index < (data.indexOf(0) < 0 ? data.length : data.indexOf(0))));
  const project = text(80);
  if (project !== 'display_example') throw new Error('只接受主程序 display_example，不能选择 OTA 恢复固件');
  let cursor = 24, checksum = 0xef;
  for (let segment = 0; segment < bytes[1]; segment++) {
    if (cursor + 8 > bytes.length) throw new Error('固件分段头不完整');
    const size = view.getUint32(cursor + 4, true); cursor += 8;
    if (size > bytes.length - cursor) throw new Error('固件分段内容不完整');
    for (const byte of bytes.subarray(cursor, cursor + size)) checksum ^= byte;
    cursor += size;
  }
  const checksumAt = Math.floor(cursor / 16 + 1) * 16 - 1;
  if (checksumAt >= bytes.length || bytes[checksumAt] !== checksum || bytes.subarray(cursor, checksumAt).some(byte => byte !== 0))
    throw new Error('固件镜像校验和错误');
  let end = checksumAt + 1;
  if (bytes[23] === 1) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice(0, end)));
    if (end + 32 > bytes.length || hash.some((byte, index) => byte !== bytes[end + index])) throw new Error('固件内嵌 SHA-256 校验失败');
    end += 32;
  } else if (bytes[23] !== 0) throw new Error('固件摘要标志无效');
  if (end !== bytes.length) throw new Error('请选择独立主应用 BIN，镜像包含额外分区或尾部数据');
  return { target: 'esp32s3', target_role: 'main', project_name: project, version: text(48),
    size: bytes.length, sha256: hex(await crypto.subtle.digest('SHA-256', bytes.slice())) };
}
