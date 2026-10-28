import { useSyncExternalStore } from 'react';

const KEY = 'nb.wrap';

// line wrapping of text files: one switch for every file view (the button in a file's header, Alt+Z), remembered;
// on by default, so a long line reads without a horizontal scroll
let on = read();
const subs = new Set<() => void>();

function read(): boolean {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

export const wrapLines = {
  get: () => on,
  set: (v: boolean) => {
    if (v === on) return;
    on = v;
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* storage unavailable: not persisted */ }
    for (const f of subs) f();
  },
  toggle: () => wrapLines.set(!on),
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
  /** tests: re-read the saved value */
  reload: () => { on = read(); },
};

export const useWrapLines = () => useSyncExternalStore(wrapLines.subscribe, wrapLines.get);
