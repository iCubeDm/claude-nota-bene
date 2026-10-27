import { historyPrepended, type HistoryPage } from '@/store/feed.ts';
import type { AppThunk } from '@/store/store.ts';

/** What one «Show before compaction» click came to: prepended, failed (shown, retry possible), or stale (dropped). */
export type EarlierResult = 'ok' | 'failed' | 'stale';

function isPage(v: unknown): v is HistoryPage {
  const o = v as Partial<HistoryPage> | null;
  return !!o && Array.isArray(o.events) && Number.isInteger(o.segment) && typeof o.more === 'boolean';
}

/**
 * Loads the newest archived segment not yet in the feed (`before = earlier + 1`, R-M7-4) and prepends it.
 * - 409: the server's conversation is not this feed's (a switch or /clear raced the click): failed, nothing prepended.
 * - 404: the archive has nothing below: an empty last page, so the button goes.
 * - An answer arriving after a replay, a /clear or a session change (another epoch or id) is dropped.
 * `beforePrepend` runs right before the prepend is dispatched, in the same task: the feed measures its scroll there.
 */
export const loadEarlier = (beforePrepend?: () => void): AppThunk<Promise<EarlierResult>> => async (dispatch, getState) => {
  const f = getState().feed;
  const session = f.session?.id;
  if (!session || f.earlier <= 0) return 'failed';
  const { epoch, earlier } = f;
  let page: HistoryPage;
  try {
    const r = await fetch(`/history?session=${encodeURIComponent(session)}&before=${earlier + 1}`);
    if (r.status === 404) page = { events: [], segment: earlier, more: false };
    else if (!r.ok) return stale() ? 'stale' : 'failed';
    else {
      const j: unknown = await r.json();
      if (!isPage(j)) return 'failed';
      page = j;
    }
  } catch {
    return stale() ? 'stale' : 'failed';
  }
  if (stale()) return 'stale';
  beforePrepend?.();
  dispatch(historyPrepended({ ...page, session, epoch }));
  return 'ok';

  function stale(): boolean {
    const now = getState().feed;
    // `earlier` moved: another click's page landed first; the feed would drop this one
    return now.epoch !== epoch || now.session?.id !== session || now.earlier !== earlier;
  }
};
