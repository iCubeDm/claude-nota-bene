import { useSyncExternalStore } from 'react';
import { useT } from '@/i18n/index.ts';
import { dismissToast, getToasts, pauseToast, resumeToast, subscribeToasts } from './toast.ts';

/** Top-right under the header (prototype: top 56px, right 16px, 380px). The live region stays mounted so additions are announced. */
export function Toasts() {
  const t = useT();
  const list = useSyncExternalStore(subscribeToasts, getToasts);
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed top-14 right-4 z-[20] flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {list.map((x) => (
        <div
          key={x.id}
          data-testid="toast"
          onMouseEnter={() => pauseToast(x.id)}
          onMouseLeave={() => resumeToast(x.id)}
          className="pointer-events-auto rounded-xl border border-destructive/40 bg-card p-3 text-xs text-foreground shadow-[0_8px_30px_rgba(0,0,0,0.4)]"
        >
          <div className="flex items-start gap-2">
            <b className="min-w-0 flex-1 text-destructive">{x.title}{x.count > 1 ? ` ×${x.count}` : ''}</b>
            <button
              type="button"
              aria-label={t('close')}
              onClick={() => dismissToast(x.id)}
              className="-mt-0.5 grid size-5 flex-none cursor-pointer place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <pre className="mt-1.5 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{x.msg}</pre>
        </div>
      ))}
    </div>
  );
}
