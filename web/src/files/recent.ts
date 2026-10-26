import type { SavedFile } from '@/tabs/slice.ts';

/** Recently opened files of a project root, newest first (M6-13). Stored under `recent:<root>`, at most RECENT_MAX. */
export const RECENT_MAX = 50;
export const recentKey = (root: string) => `recent:${root}`;

const same = (a: SavedFile, b: SavedFile) => a.path === b.path && (a.src ?? 'here') === (b.src ?? 'here');

const isSaved = (v: unknown): v is SavedFile => {
  const o = v as SavedFile;
  return !!o && typeof o.path === 'string' && (o.src === undefined || typeof o.src === 'string') && (o.ref === undefined || typeof o.ref === 'string');
};

export function readRecent(root: string): SavedFile[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(root)) ?? '[]');
    return Array.isArray(v) ? v.filter(isSaved).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Moves `f` to the front (one entry per path and source) and trims the list. */
export function pushRecent(root: string, f: SavedFile): void {
  const next = [f, ...readRecent(root).filter((x) => !same(x, f))].slice(0, RECENT_MAX);
  try { localStorage.setItem(recentKey(root), JSON.stringify(next)); } catch { /* storage unavailable: not persisted */ }
}

// the modal's open state: opened by the keymap (Cmd/Ctrl+E), read by RecentFiles
let isOpen = false;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
export const recentModal = {
  open: () => { isOpen = true; emit(); },
  close: () => { isOpen = false; emit(); },
  get: () => isOpen,
  subscribe: (f: () => void) => { subs.add(f); return () => void subs.delete(f); },
};
