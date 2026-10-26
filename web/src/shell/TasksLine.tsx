import { useEffect, useState } from 'react';
import { fmtK } from '@/lib/format.ts';
import { useT } from '@/i18n/index.ts';
import { useAppSelector } from '@/store/store.ts';
import { selectTasks } from '@/tasks/slice.ts';

/** `Ns` under a minute, else `m:ss` (prototype renderTasks). */
export function fmtElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
}

/** Date.now(), refreshed every second, with one interval that exists only while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** Background tasks (subagents, shell): one line each above the composer. */
export function TasksLine() {
  const t = useT();
  const tasks = useAppSelector(selectTasks);
  const live = Object.entries(tasks);
  const now = useNow(live.length > 0);
  if (!live.length) return null;
  return (
    <div role="status" aria-label={t('tasksLabel')} className="flex flex-col gap-0.5 pt-1.5 text-[11.5px] text-muted-foreground">
      {live.map(([id, tk]) => {
        const meta = [fmtElapsed(now - tk.start), tk.tokens ? `${fmtK(tk.tokens)} tok` : '', tk.tool].filter(Boolean).join(' · ');
        return (
          <div key={id} title={tk.summary || tk.desc} className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
            <span aria-hidden className="animate-pulse text-nb-accent">⚙</span>
            <span className="overflow-hidden text-ellipsis text-foreground/85">{tk.desc}</span>
            <span className="flex-none font-mono text-[10.5px]">{meta}</span>
          </div>
        );
      })}
    </div>
  );
}
