import { keysLabel, BINDINGS } from './keymap.ts';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { DRAWER_ID, INDICATOR_ID } from '@/tasks/TasksDrawer.tsx';
import { selectDrawerOpen, selectFinishedCount, selectRunningCount, toggleDrawer } from '@/tasks/slice.ts';

const hotkey = (() => { const b = BINDINGS.find((x) => x.id === 'hk_tasks'); return b ? keysLabel(b) : ''; })();

/**
 * Under the composer: `⚙ N tasks` with N = the running ones, pulsing while N > 0; when only finished tasks are left,
 * quietly `✓ N`; nothing at all when there are none. A click (or Alt+T) opens the drawer.
 */
export function TasksIndicator() {
  const t = useT();
  const d = useAppDispatch();
  const running = useAppSelector(selectRunningCount);
  const finished = useAppSelector(selectFinishedCount);
  const open = useAppSelector(selectDrawerOpen);
  if (running + finished === 0) return null;
  const live = running > 0;
  return (
    <div className="flex pt-1.5 text-[11.5px] text-muted-foreground">
      <button
        type="button"
        id={INDICATOR_ID}
        data-running={live || undefined}
        aria-expanded={open}
        aria-controls={open ? DRAWER_ID : undefined}
        aria-label={t('tasksLabel')}
        title={`${t('tasksLabel')} (${hotkey})`}
        onClick={() => d(toggleDrawer())}
        className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {live ? (
          <>
            <span aria-hidden className="animate-pulse text-nb-accent">⚙</span>
            <span data-tasks-count>{t('tasksRunning', running)}</span>
          </>
        ) : (
          <>
            <span aria-hidden>✓</span>
            <span data-tasks-count>{finished}</span>
          </>
        )}
      </button>
    </div>
  );
}
