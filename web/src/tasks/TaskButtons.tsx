import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectToolResulted } from '@/subagent/slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { backgroundTask, selectTaskControls, stopTask, type Task } from './slice.ts';

/** How long the Stop button stays on "Stop?" before it goes back. */
export const STOP_CONFIRM_MS = 3000;

export const BTN = 'flex-none cursor-pointer rounded border border-border-soft px-2 py-0.5 text-[11px] text-foreground hover:border-border hover:bg-muted';

/**
 * Stop, with the confirmation inline: the first click turns the button into "Stop?" for STOP_CONFIRM_MS, a second click
 * in that time stops the task; no modal. Absent (not disabled) for a server older than protocol 8.
 */
export function StopButton({ id, className = BTN }: { id: string; className?: string }) {
  const t = useT();
  const d = useAppDispatch();
  const controls = useAppSelector(selectTaskControls);
  const [sure, setSure] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setSure(false); clearTimeout(timer.current); }, [id]);
  if (!controls) return null;
  return (
    <button
      type="button"
      data-task-stop
      data-sure={sure || undefined}
      title={t('taskStopTip')}
      onClick={() => {
        clearTimeout(timer.current);
        if (sure) {
          setSure(false);
          d(stopTask(id));
        } else {
          setSure(true);
          timer.current = setTimeout(() => setSure(false), STOP_CONFIRM_MS);
        }
      }}
      className={sure ? className.replace('border-border-soft', 'border-destructive').replace('text-foreground', 'text-destructive') : className}
    >
      {sure ? t('taskStopConfirm') : t('taskStop')}
    </button>
  );
}

/** A running task is in the foreground while the tool call that started it has no result yet. */
export const useForeground = (task: Task | undefined): boolean =>
  useAppSelector((s) => !!task?.call && task.status === 'running' && !selectToolResulted(s, task.call));

/** To background: only for a foreground task, and only to a server that has it. */
export function BackgroundButton({ task, className = BTN, after }: { task: Task; className?: string; after?: () => void }) {
  const t = useT();
  const d = useAppDispatch();
  const controls = useAppSelector(selectTaskControls);
  const foreground = useForeground(task);
  if (!controls || !foreground || !task.call) return null;
  const call = task.call;
  return (
    <button type="button" data-task-background title={t('taskBackgroundTip')} onClick={() => { d(backgroundTask(call)); after?.(); }} className={className}>
      {t('taskBackground')}
    </button>
  );
}
