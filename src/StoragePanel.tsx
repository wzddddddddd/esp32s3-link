import type { Capacity, StorageSnapshot } from './cloud/storage';
import { measured, memoryLabels } from './cloud/storage';
import { formatSize } from './demo';

function Usage({ label, value, entries = false }: { label: string; value: Capacity; entries?: boolean }) {
  const known = measured(value);
  const size = entries ? (n: number) => `${n} 项` : formatSize;
  return <div className="storage-row">
    <div><strong>{label}</strong><span>总量 {size(value.total || 0)}</span></div>
    {known ? <progress aria-label={`${label}使用率`} max={value.total || 1} value={value.used} /> : <div className="storage-unknown" aria-label={`${label}占用未测量`} />}
    <small>{known ? `已用 ${size(value.used!)} · 剩余 ${size(value.free!)}` :
      value.kind === 'reserved' ? '保留分区，不能作为文件空间' : '占用未测量，不能据此判断可用空间'}
      {value.largest !== undefined && ` · 最大连续块 ${formatSize(value.largest)}`}</small>
  </div>;
}

export default function StoragePanel({ storage }: { storage?: StorageSnapshot | null }) {
  if (!storage || storage.version !== 1) return <p className="muted">等待固件回报分区容量；旧固件只提供 SD 卡信息。</p>;
  return <div className="storage-panel">
    {storage.sd?.status === 'ready' ? <Usage label="SD 卡文件存储" value={storage.sd} /> : <p>SD 卡不可用，请检查挂载状态。</p>}
    <h3>运行内存</h3>
    {(Array.isArray(storage.memory) ? storage.memory : []).map(v => <Usage key={v.name} label={memoryLabels[v.name || ''] || v.name || '内存'} value={v} />)}
    {storage.flash && <>
      <h3>Flash 分区 · {formatSize(storage.flash.total)}</h3>
      <Usage label="Flash 分区分配" value={{ total: storage.flash.total, used: storage.flash.partition_bytes, free: storage.flash.outside_partitions }} />
      {(Array.isArray(storage.flash.partitions) ? storage.flash.partitions : []).map(v => <Usage key={v.name} label={v.name || '分区'} value={v} />)}
      <small>分区外空间 {formatSize(storage.flash.outside_partitions)}（含启动程序、分区表及未分配区域）。固件和资源分区的剩余量是镜像余量，不是 SD 文件空间。</small>
    </>}
    {storage.nvs_entries && <Usage label="NVS 存储项" value={storage.nvs_entries} entries />}
    <small>设备运行 {(storage.uptime_ms / 60000).toFixed(1)} 分钟；容量随心跳更新，离线时为最后一次快照。</small>
  </div>;
}
