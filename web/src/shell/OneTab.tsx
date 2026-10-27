import { useT } from '@/i18n/index.ts';
import { selectConn, takeOver, useAppDispatch, useAppSelector } from '@/store/store.ts';

/**
 * One tab per window (R-M7-8): a full-window overlay when another tab owns the session (`occupied`: we arrived second)
 * or took it from us (`taken`). The app stays mounted under it, inert. «Работать здесь» takes the window over.
 */
export function OneTab() {
  const t = useT();
  const dispatch = useAppDispatch();
  const conn = useAppSelector(selectConn);
  if (conn !== 'occupied' && conn !== 'taken') return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="onetab-title"
      data-testid="onetab"
      data-state={conn}
      className="fixed inset-0 z-[100] grid place-items-center bg-background/95"
    >
      <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
        <h1 id="onetab-title" className="text-lg font-semibold text-foreground">
          {t(conn === 'occupied' ? 'occupiedTitle' : 'takenTitle')}
        </h1>
        <button
          type="button"
          autoFocus
          onClick={() => void dispatch(takeOver())}
          className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('workHere')}
        </button>
      </div>
    </div>
  );
}
