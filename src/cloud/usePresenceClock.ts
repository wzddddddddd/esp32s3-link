import { useEffect, useState } from 'react';
export function usePresenceClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    window.addEventListener('offline', tick); window.addEventListener('online', tick);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); window.removeEventListener('offline', tick); window.removeEventListener('online', tick); document.removeEventListener('visibilitychange', tick); };
  }, []);
  return now;
}
