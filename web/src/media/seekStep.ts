import { useSyncExternalStore } from 'react';

const KEY = 'nb.seekStep';

/** The seconds a ← / → press seeks by; the bar's step chip picks one. */
export const SEEK_STEPS = [0.1, 0.5, 1, 5] as const;
export type SeekStepValue = (typeof SEEK_STEPS)[number];
const DEFAULT: SeekStepValue = 5;

// one pref for every player (file tabs, chat replies, md files), remembered; unknown stored values fall back to the default
let cur = read();
const subs = new Set<() => void>();

function read(): SeekStepValue {
  try {
    const n = Number(localStorage.getItem(KEY));
    return SEEK_STEPS.find((s) => s === n) ?? DEFAULT;
  } catch { return DEFAULT; }
}

export const seekStep = {
  get: (): SeekStepValue => cur,
  set: (v: SeekStepValue) => {
    if (v === cur) return;
    cur = v;
    try { localStorage.setItem(KEY, String(v)); } catch { /* storage unavailable: not persisted */ }
    for (const f of subs) f();
  },
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
  /** tests: re-read the saved value */
  reload: () => { cur = read(); },
};

export const useSeekStep = () => useSyncExternalStore(seekStep.subscribe, seekStep.get);
