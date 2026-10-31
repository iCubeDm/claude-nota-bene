import { useEffect, useRef } from 'react';
import { fmtK } from '@/lib/format.ts';
import { useT } from '@/i18n/index.ts';
import { AGENT_PROTOCOL } from '@/subagent/slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openAgent, openShell } from '@/tabs/slice.ts';
import { selectDrawerOpen, selectRunningCount, selectTaskControls, selectTaskRows, setDrawer, TASKS_PROTOCOL, type Task } from './slice.ts';
import { BackgroundButton, BTN, StopButton } from './TaskButtons.tsx';
import { fmtElapsed, useNow } from './time.ts';

export const DRAWER_ID = 'tasks-drawer';
export const INDICATOR_ID = 'tasks-indicator';

const ICON: Record<Task['status'], { glyph: string; cls: string; key: 'taskRunning' | 'taskDone' | 'taskFailed' | 'taskStopped' }> = {
  running: { glyph: '●', cls: 'animate-pulse text-nb-accent', key: 'taskRunning' },
  done: { glyph: '✓', cls: 'text-success', key: 'taskDone' },
  failed: { glyph: '✕', cls: 'text-destructive', key: 'taskFailed' },
  stopped: { glyph: '■', cls: 'text-muted-foreground', key: 'taskStopped' },
};

/**
 * The tasks drawer: slides up over the bottom of the feed (an overlay, the feed keeps its size). Closed by Esc, a click
 * outside it (the indicator toggles it itself) and Alt+T. One row per task; a task launched by a subagent task is
 * nested under it.
 */
export function TasksDrawer() {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectDrawerOpen);
  const capabilities = useAppSelector((s) => s.controls.capabilities);
  const rows = useAppSelector(selectTaskRows);
  const running = useAppSelector(selectRunningCount);
  const protocol = useAppSelector((s) => s.controls.protocol);
  const controls = useAppSelector(selectTaskControls);
  const now = useNow(open && running > 0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => d(setDrawer(false));
    // capture phase + preventDefault: the composer's Esc (interrupt the agent) sees it handled
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // what really owns Esc: modal dialogs, menus, listboxes, Radix popovers. A plain role=dialog (the comment popup) does not:
      // its own Esc is a document-capture handler that runs after this one, so the drawer closes first and the popup keeps its draft
      if ((e.target as HTMLElement | null)?.closest?.('[data-nb-modal], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // one Esc closes one layer (a comment popup or picker open under it keeps its draft)
      close();
    };
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (box.current?.contains(el) || el?.closest?.(`#${INDICATOR_ID}`)) return;
      close();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, d]);

  if (!open) return null;
  return (
    <div
      ref={box}
      id={DRAWER_ID}
      role="region"
      aria-label={t('tasksDrawer')}
      data-tasks-drawer
      className="nb-drawer absolute inset-x-0 bottom-0 z-[15] mx-auto max-h-[60%] max-w-[860px] overflow-auto rounded-t-xl border border-b-0 border-border-soft bg-card/95 shadow-[0_-8px_30px_rgba(0,0,0,0.35)] backdrop-blur-[16px]"
    >
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">{t('tasksNone')}</div>
      ) : (
        <ul className="flex flex-col py-1">
          {rows.map(({ id, task, depth }) => {
            const icon = ICON[task.status];
            const meta = [task.type, fmtElapsed((task.end ?? now) - task.start), task.tokens ? `${fmtK(task.tokens)} tok` : '', task.tool].filter(Boolean).join(' · ');
            const canOpen = (task.kind === 'agent' && task.type !== 'remote_agent' && !!task.call && protocol >= AGENT_PROTOCOL) || (task.kind === 'shell' && protocol >= TASKS_PROTOCOL && capabilities?.taskOutput !== false);
            return (
              <li
                key={id}
                data-task={id}
                data-status={task.status}
                data-kind={task.kind}
                style={{ paddingLeft: 12 + depth * 18 }}
                className="flex items-center gap-2 py-1 pr-3 text-[12px] hover:bg-muted/40"
              >
                <span aria-label={t(icon.key)} title={t(icon.key)} data-task-status className={`w-3 flex-none text-center ${icon.cls}`}>{icon.glyph}</span>
                <span className="min-w-0 flex-[0_1_40%] truncate text-foreground/90" title={task.desc}>{task.desc}</span>
                <span className="flex-none font-mono text-[10.5px] text-muted-foreground" data-task-meta>{meta}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={task.summary || undefined} data-task-summary>{task.summary}</span>
                {canOpen && (
                  <button
                    type="button"
                    data-task-open
                    className={BTN}
                    onClick={() => {
                      if (task.kind === 'agent' && task.call) d(openAgent({ tool: task.call, title: task.desc }));
                      else d(openShell({ task: id, title: task.desc }));
                      d(setDrawer(false));
                    }}
                  >
                    {t('taskOpen')}
                  </button>
                )}
                {controls && task.status === 'running' && <StopButton id={id} />}
                {task.status === 'running' && <BackgroundButton id={id} task={task} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
