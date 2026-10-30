import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source, TreeEntry } from '@nota-bene/shared';
import { setDirs } from '@/tree/slice.ts';
import { useAppDispatch, type RootState } from '@/store/store.ts';
import { useStore } from 'react-redux';
import { isFixed } from '../sources.ts';
import { apiFetch } from '@/net/auth.ts';

type Loaded = TreeEntry[] | 'gone' | 'error';

/** Always build the query with encodeURIComponent: a `+` in a name must survive. */
export async function loadDir(rel: string, src: string): Promise<Loaded> {
  try {
    const r = await apiFetch(`/tree?path=${encodeURIComponent(rel)}${src === 'here' ? '' : `&src=${encodeURIComponent(src)}`}`);
    if (r.status === 404) return 'gone';
    if (!r.ok) return 'error';
    return (await r.json()) as TreeEntry[];
  } catch {
    return 'error';
  }
}

/** A folder is shown when every ancestor is open: only those are fetched and refreshed (a closed parent hides the rest). */
export const shownIn = (open: Set<string>) => (p: string): boolean => {
  for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (!open.has(p.slice(0, i))) return false;
  return true;
};

/** The "Expand all" run as the entries need to see it: whether it is going, and how to end it (a source switch ends it). */
export type ExpandRun = { running: boolean; stop: () => void };

type Args = { open: boolean; dirs: string[]; src: string; sources: Source[]; turnSeq: number; run: ExpandRun };

/**
 * The listings of the shown folders: lazy loading, the merged refresh after a turn and on demand.
 * `run.running` is the coupling with "Expand all": no refresh during a run, a turn missed meanwhile is refreshed once it is over.
 */
export function useTreeEntries({ open, dirs, src, sources, turnSeq, run }: Args) {
  const d = useAppDispatch();
  const store = useStore<RootState>();
  const [entries, setEntries] = useState<Record<string, TreeEntry[]>>({});
  const [loading, setLoading] = useState(0);
  const [failed, setFailed] = useState(false);
  const requested = useRef(new Set<string>());
  const busy = useRef(false);
  // the source the loaded entries belong to: a switch drops them, and an answer for the previous source is ignored
  const shown = useRef(src);
  const runningRef = useRef(false);
  runningRef.current = run.running;
  const missedTurn = useRef(false); // a turn ended during "Expand all": refreshed once it is over
  if (shown.current !== src) {
    shown.current = src;
    requested.current = new Set();
    if (run.running) run.stop();
  }
  useEffect(() => setEntries({}), [src]);

  const track = useCallback(async <T,>(p: Promise<T>): Promise<T> => {
    setLoading((n) => n + 1);
    try { return await p; } finally { setLoading((n) => n - 1); }
  }, []);

  // Lazy expand: any shown folder in `dirs` (clicked, restored, revealed) is fetched once; one under a closed parent
  // waits until it is shown
  useEffect(() => {
    if (!open) return;
    const want = ['', ...dirs].filter(shownIn(new Set(dirs))).filter((p) => !requested.current.has(p));
    for (const p of want) {
      requested.current.add(p);
      void track(loadDir(p, src)).then((r) => {
        if (shown.current !== src) return;
        if (r === 'error') { requested.current.delete(p); setFailed(true); return; }
        setEntries((e) => ({ ...e, [p]: r === 'gone' ? [] : r }));
      });
    }
  }, [open, dirs, src, track]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      // the shown folders only (a long-collapsed subtree is not re-listed on every turn)
      const paths = ['', ...dirs.filter(shownIn(new Set(dirs)))];
      // the root it was asked for: an answer that lands after a switch to another root (same 'here' source, other
      // folder) must not prune that root's folders with this one's listing
      const gen = store.getState().tabs.rootGen;
      const results = await track(Promise.all(paths.map((p) => loadDir(p, src))));
      if (shown.current !== src || store.getState().tabs.rootGen !== gen) return;
      // merged into what is there now: listings loaded meanwhile (another click) stay; an error keeps the old listing
      const gone = new Set<string>();
      let bad = false;
      const fresh: Record<string, TreeEntry[]> = {};
      paths.forEach((p, i) => {
        const r = results[i];
        if (r === 'error') bad = true;
        else if (r === 'gone') { if (p === '') fresh[p] = []; else gone.add(p); } // a vanished folder is dropped silently
        else fresh[p] = r;
      });
      setFailed(bad);
      setEntries((e) => {
        const n = { ...e, ...fresh };
        for (const p of gone) delete n[p];
        return n;
      });
      for (const p of gone) requested.current.delete(p);
      // pruned from the folders open NOW, not those of the request (a click meanwhile stays)
      const cur = store.getState().tree.dirs;
      if (gone.size && cur.some((p) => gone.has(p))) d(setDirs(cur.filter((p) => !gone.has(p))));
    } finally {
      busy.current = false;
    }
  }, [dirs, src, d, track, store]);

  // refresh after every live turn (replay does not move turnSeq); the first value is not a change. A branch only
  // changes with a commit: no refresh for it
  const seenTurn = useRef(turnSeq);
  useEffect(() => {
    if (seenTurn.current === turnSeq) return;
    seenTurn.current = turnSeq;
    if (isFixed(src, sources) || !(open || requested.current.size > 0)) return;
    if (runningRef.current) missedTurn.current = true; // after "Expand all", not across it
    else void refresh();
  }, [turnSeq, open, src, sources, refresh]);
  useEffect(() => {
    if (run.running || !missedTurn.current) return;
    missedTurn.current = false;
    void refresh();
  }, [run.running, refresh]);

  return { entries, setEntries, loading, failed, setFailed, requested, shown, track, refresh };
}

export type TreeEntries = ReturnType<typeof useTreeEntries>;
