export const PRESENCE_TTL_MS = 10_000;
export const OFFLINE_MESSAGE = 'Wi-Fi 未连接，请先让设备连接 Wi-Fi 后再操作。';
export interface DevicePresence { wifi_connected?: boolean; presence_seen?: string | null; last_seen?: string | null }
export function deviceOnline(device: DevicePresence | undefined, now = Date.now()) {
  if (!device || device.wifi_connected === false) return false;
  const seen = Date.parse(device.presence_seen ?? device.last_seen ?? '');
  return Number.isFinite(seen) && now - seen >= -5000 && now - seen < PRESENCE_TTL_MS;
}
export function offlineError(error: unknown) {
  return error instanceof Error && error.message.includes('Wi-Fi 未连接') ||
    !!error && typeof error === 'object' && 'message' in error && String(error.message).includes('WIFI_NOT_CONNECTED');
}
export function mergePresence<T extends DevicePresence>(current: T, incoming: Partial<T>): T {
  const before = Date.parse(current.presence_seen ?? ''), after = Date.parse(incoming.presence_seen ?? '');
  const merged = { ...current, ...incoming };
  if (Number.isFinite(before) && (!Number.isFinite(after) || after < before)) {
    merged.presence_seen = current.presence_seen;
    merged.wifi_connected = current.wifi_connected;
  }
  return merged;
}
