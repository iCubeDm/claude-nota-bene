import { useEffect, useState } from 'react';

/** `Ns` under a minute, else `m:ss` (prototype renderTasks). */
export function fmtElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
}

/** Date.now(), refreshed every second, with one interval that exists only while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
