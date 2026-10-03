export interface Capacity {
  total: number;
  used?: number;
  free?: number;
  name?: string;
  kind?: string;
  largest?: number;
}
export interface StorageSnapshot {
  version: number;
  uptime_ms: number;
  sd: Capacity & { status: string };
  memory: Capacity[];
  flash?: { total: number; partition_bytes: number; outside_partitions: number; partitions: Capacity[] };
  nvs_entries?: Capacity;
}
export function measured(row: Capacity): boolean {
  return Number.isFinite(row.total) && row.total > 0 &&
    Number.isFinite(row.used) && row.used! >= 0 && row.used! <= row.total &&
    Number.isFinite(row.free) && row.free! >= 0 && row.free! <= row.total;
}
export const memoryLabels: Record<string, string> = {
  internal: '内部 RAM 可分配堆', psram: 'PSRAM 可分配堆', dma: 'DMA 堆（与内部 RAM 重叠）',
};
