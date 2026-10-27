import { useEffect, useRef } from 'react';
import { setDirs } from '@/tree/slice.ts';
import { useAppDispatch } from '@/store/store.ts';
import { loadDir, shownIn, type TreeEntries } from './useTreeEntries.ts';

/** "Expand all" stops once the tree shows this many rows (a huge folder never freezes the sheet). */
export const EXPAND_CAP = 2000;
/** Never opened by "Expand all": dependency and VCS folders would eat the cap before the project's own (a click still opens them). */
const NO_EXPAND = new Set(['node_modules', '.git']);

export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** How many folder listings "Expand all" fetches at once. */
const EXPAND_FETCHES = 8;

type Args = {
  tree: TreeEntries; open: boolean; dirs: string[]; src: string;
  running: boolean; setRunning: (on: boolean) => void;
};

/**
 * "Expand all": opens the shown closed folders in order while the rows stay within EXPAND_CAP. The run state
 * (`running`) is owned by the caller, because useTreeEntries reads it too (no refresh during a run).
 */
export function useExpandAll({ tree, open, dirs, src, running, setRunning }: Args) {
  const d = useAppDispatch();
  const { entries, setEntries, failed, setFailed, requested, shown, track } = tree;
  // "Expand all": walk the shown closed folders in order (outer levels first); fetch each one's listing (at most
  // EXPAND_FETCHES at a time) and open it if its rows still fit under EXPAND_CAP. The first one that does not fit ends
  // the run, as do no closed folders left and a load error during the run (that folder would never load).
  const inFlight = useRef(0);
  useEffect(() => {
    if (!running) return;
    if (failed || !open) return void setRunning(false);
    const isOpen = new Set(dirs);
    if (['', ...dirs].filter(shownIn(isOpen)).some((p) => !entries[p])) return; // the open folders are still loading
    // breadth first: the rows shown now, and the closed folders level by level
    let rows = 0;
    const closed: string[] = [];
    let level = [''];
    while (level.length) {
      const next: string[] = [];
      for (const dir of level) {
        for (const e of entries[dir] ?? []) {
          rows++;
          if (!e.dir) continue;
          const p = join(dir, e.name);
          // node_modules and .git: never opened, nor walked into when the user opened one
          if (NO_EXPAND.has(e.name)) continue;
          if (isOpen.has(p)) next.push(p);
          else closed.push(p);
        }
      }
      level = next;
    }
    const add: string[] = [];
    let stop = rows >= EXPAND_CAP || !closed.length;
    for (const p of stop ? [] : closed) {
      const kids = entries[p];
      if (!kids) {
        // fetch it (and the next few) before deciding; the effect runs again as listings land
        for (const q of closed.slice(closed.indexOf(p))) {
          if (inFlight.current >= EXPAND_FETCHES) break;
          if (entries[q] || requested.current.has(q)) continue;
          requested.current.add(q);
          inFlight.current++;
          void track(loadDir(q, src)).then((r) => {
            inFlight.current--;
            if (shown.current !== src) return;
            if (r === 'error') { requested.current.delete(q); setFailed(true); return; }
            setEntries((e) => ({ ...e, [q]: r === 'gone' ? [] : r }));
          });
        }
        break;
      }
      if (rows + kids.length > EXPAND_CAP) { stop = true; break; }
      rows += kids.length;
      add.push(p);
    }
    if (add.length) d(setDirs([...dirs, ...add]));
    else if (stop) setRunning(false);
  }, [running, entries, dirs, failed, open, src, track, d]);

  /** The button: no-op while running; clears a previous failure, then starts. */
  const start = () => { if (running) return; setFailed(false); setRunning(true); };
  return { start };
}
