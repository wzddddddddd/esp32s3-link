import { useEffect, useId, useRef } from 'react';
import { WifiOff } from 'lucide-react';
import { OFFLINE_MESSAGE } from './cloud/presence';
export default function OfflineDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); }, [open]);
  return <dialog ref={dialog} className="modal" aria-labelledby={title} onClose={onClose}>
    <WifiOff size={30} aria-hidden="true" /><h2 id={title}>Wi-Fi 未连接</h2>
    <p className="dialog-description">{OFFLINE_MESSAGE}</p>
    <p className="muted">离线时不会创建新的设备任务。</p>
    <div className="modal-actions"><button className="button primary" autoFocus onClick={() => dialog.current?.close()}>知道了</button></div>
  </dialog>;
}
