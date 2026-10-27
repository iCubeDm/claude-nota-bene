import { useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { loadEarlier } from './history.ts';

/**
 * «Show before compaction» (R-M7-4): the first item of the feed while archived segments remain (`feed.earlier > 0`).
 * One click loads one segment, newest first. A failure (network, a 409 after the session changed) is shown and the
 * button stays for a retry; a stale answer is dropped by the thunk. `beforePrepend` lets the feed measure its scroll.
 */
export function EarlierButton({ beforePrepend }: { beforePrepend?: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const earlier = useAppSelector((s) => s.feed.earlier);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  if (earlier <= 0) return null;
  const load = async () => {
    setState('loading');
    const r = await dispatch(loadEarlier(beforePrepend));
    setState(r === 'failed' ? 'failed' : 'idle');
  };
  const loading = state === 'loading';
  return (
    <div data-earlier className="mb-3 flex items-center justify-center gap-2 font-mono text-[11px] text-muted-foreground">
      <button
        type="button"
        onClick={() => void load()}
        disabled={loading}
        className="rounded-full border border-border-soft px-3 py-1 hover:border-border hover:text-foreground disabled:cursor-wait disabled:opacity-60"
      >
        {loading ? t('earlierLoading') : t('earlierShow')}
      </button>
      {state === 'failed' && <span role="status" className="text-destructive">{t('earlierFailed')}</span>}
    </div>
  );
}
