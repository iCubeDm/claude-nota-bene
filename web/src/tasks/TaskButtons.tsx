import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { backgroundTask, selectForeground, selectTaskControls, stopTask, type Task } from './slice.ts';

/** How long the Stop button stays on "Stop?" before it goes back. */
export const STOP_CONFIRM_MS = 3000;

/** How long a sent Stop waits for its answer before the button is offered again. */
export const STOP_WAIT_MS = 5000;

export const BTN = 'flex-none cursor-pointer rounded border border-border-soft px-2 py-0.5 text-[11px] text-foreground hover:border-border hover:bg-muted';

/**
 * Stop, with the confirmation inline: the first click turns the button into "Stop?" for STOP_CONFIRM_MS, a second click
 * in that time stops the task; no modal. Absent (not disabled) for a server older than protocol 8.
 */
export function StopButton({ id, className = BTN }: { id: string; className?: string }) {
  const t = useT();
  const d = useAppDispatch();
  const controls = useAppSelector(selectTaskControls);
  const refusals = useAppSelector((s) => s.tasksUi.refusals);
  const [sure, setSure] = useState(false);
  // sent, no answer yet: the button waits (no second send) until the task ends (the button goes away), the server refuses, or STOP_WAIT_MS
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(wait.current); }, []);
  useEffect(() => { setSure(false); setPending(false); clearTimeout(timer.current); clearTimeout(wait.current); }, [id]);
  useEffect(() => { setPending(false); clearTimeout(wait.current); }, [refusals]);
  if (!controls) return null;
  if (pending) return <button type="button" data-task-stop data-pending disabled className={`${className} cursor-default opacity-60`}>{t('taskStopping')}</button>;
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
          setPending(true);
          wait.current = setTimeout(() => setPending(false), STOP_WAIT_MS);
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

/** A running task is in the foreground when the CLI says so, else (see selectForeground) by its call having no result yet. */
export const useForeground = (id: string | undefined): boolean => useAppSelector((s) => !!id && selectForeground(s, id));

/** To background: only for a foreground task, and only to a server that has it. */
export function BackgroundButton({ id, task, className = BTN, after }: { id: string; task: Task; className?: string; after?: () => void }) {
  const t = useT();
  const d = useAppDispatch();
  const controls = useAppSelector(selectTaskControls);
  const foreground = useForeground(id);
  if (!controls || !foreground || !task.call) return null;
  const call = task.call;
  return (
    <button type="button" data-task-background title={t('taskBackgroundTip')} onClick={() => { d(backgroundTask(call)); after?.(); }} className={className}>
      {t('taskBackground')}
    </button>
  );
}
