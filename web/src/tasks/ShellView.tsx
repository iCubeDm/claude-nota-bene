import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TaskOutputView } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { useAppSelector } from '@/store/store.ts';
import type { ShellTab } from '@/tabs/slice.ts';
import { plainOutput } from './ansi.ts';
import { selectTaskControls, TASKS_PROTOCOL } from './slice.ts';
import { StopButton } from './TaskButtons.tsx';

/** How often a running task's output is read again while its tab is the visible one. */
export const SHELL_POLL_MS = 1000;
/** After a failed read: tried again this often. */
const RETRY_MS = 3000;

type Out = { status: 'loading' | 'ok' | 'gone' | 'error'; output: string; totalBytes: number; truncated: boolean; running: boolean; error?: string };
const blank: Out = { status: 'loading', output: '', totalBytes: 0, truncated: false, running: true };

function isView(v: unknown): v is TaskOutputView {
  const o = v as Partial<TaskOutputView> | null;
  return !!o && typeof o.output === 'string' && typeof o.totalBytes === 'number' && typeof o.truncated === 'boolean' && typeof o.running === 'boolean';
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * A background shell task's output in its own tab, as plain text in a monospace pre (escape sequences are removed, never
 * interpreted). Polling: `/task-output` every SHELL_POLL_MS while the tab is visible and the task runs; the read that sees
 * `running: false` (and one more when the task's end reaches the store first) is the last. A task the server does not know
 * (another session, a restarted server) is said in a line. The view sticks to the bottom only while it is at the bottom.
 */
export function ShellView({ tab, active }: { tab: ShellTab; active: boolean }) {
  const t = useT();
  const { task } = tab;
  const session = useAppSelector((s) => s.feed.session?.id ?? null);
  const info = useAppSelector((s) => s.tasks[task]);
  const controls = useAppSelector(selectTaskControls);
  const protocol = useAppSelector((s) => s.controls.protocol);
  const ended = !!info && info.status !== 'running';
  const [out, setOut] = useState<Out>(blank);
  const final = useRef(false); // the last read said the task is over: nothing more to fetch
  const pre = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    final.current = false;
    setOut(blank);
  }, [session, task]);

  useEffect(() => {
    if (!session || !active || protocol < TASKS_PROTOCOL || final.current) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let next = RETRY_MS;
      try {
        const r = await fetch(`/task-output?session=${encodeURIComponent(session)}&task=${encodeURIComponent(task)}`, { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        if (r.status === 404 || r.status === 409) {
          final.current = true;
          return setOut((o) => ({ ...o, status: 'gone', running: false }));
        }
        const v: unknown = r.ok ? await r.json() : null;
        if (ctl.signal.aborted) return;
        if (!r.ok || !isView(v)) {
          setOut((o) => ({ ...o, status: o.status === 'ok' ? 'ok' : 'error', error: r.ok ? 'bad answer' : `HTTP ${r.status}` }));
        } else {
          setOut({ status: 'ok', output: v.output, totalBytes: v.totalBytes, truncated: v.truncated, running: v.running });
          if (!v.running) return void (final.current = true);
          next = SHELL_POLL_MS;
        }
      } catch (e) {
        if (ctl.signal.aborted) return;
        setOut((o) => ({ ...o, status: o.status === 'ok' ? 'ok' : 'error', error: e instanceof Error ? e.message : String(e) }));
      }
      timer = setTimeout(() => void tick(), next);
    };
    void tick();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
    // `ended`: the task's end reached the store, so the read that follows is the one after the end
  }, [session, task, active, protocol, ended]);

  const text = plainOutput(out.output);
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const earlierKb = out.truncated ? Math.max(1, Math.round((out.totalBytes - bytes(out.output)) / 1024)) : 0;
  const status = info?.status ?? (out.status === 'ok' && !out.running ? 'done' : 'running');
  const running = info ? info.status === 'running' : out.running;
  return (
    <div data-pane={tab.id} data-shell={task} data-anchor-skip hidden={!active} className="grid-pane relative flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-border-soft px-4 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/90" title={tab.title}>{tab.title}</span>
        <span data-shell-status data-status={status} className={running ? 'text-nb-accent' : 'text-muted-foreground'}>
          {out.status === 'gone' ? t('shellGoneShort') : t(running ? 'taskRunning' : status === 'failed' ? 'taskFailed' : status === 'stopped' ? 'taskStopped' : 'taskDone')}
        </span>
        {controls && running && out.status !== 'gone' && <StopButton id={task} />}
      </div>
      <div
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
        className="min-h-0 flex-1 overflow-auto px-4 py-2"
      >
        {out.status === 'gone' ? (
          <div data-kind="shell-status" role="status" className="py-6 text-center text-sm text-muted-foreground">{t('shellGone')}</div>
        ) : protocol < TASKS_PROTOCOL ? (
          <div data-kind="shell-status" role="status" className="py-6 text-center text-sm text-muted-foreground">{t('shellNeedsRestart')}</div>
        ) : out.status === 'loading' ? (
          <div data-kind="shell-status" role="status" className="py-6 text-center text-sm text-muted-foreground">{t('shellLoading')}</div>
        ) : (
          <>
            {out.error && out.status !== 'ok' ? <div role="alert" className="mb-2 text-sm text-destructive">{t('shellFailed', out.error)}</div> : null}
            {out.error && out.status === 'ok' ? <div data-shell-stale className="mb-2 text-[11px] text-destructive">{t('shellStale', out.error)}</div> : null}
            {earlierKb > 0 && <div data-shell-truncated className="mb-1 font-mono text-[11px] text-muted-foreground">{t('shellEarlier', earlierKb)}</div>}
            <pre data-shell-output className="font-mono text-[12px] leading-[1.45] break-words whitespace-pre-wrap text-foreground/90">{text || (out.status === 'ok' ? t('shellEmpty') : '')}</pre>
          </>
        )}
      </div>
    </div>
  );
}
