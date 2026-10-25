import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';

/**
 * `open`: the sheet. `dirs`: expanded folders (project-relative, '/'-joined). `reveal`: a request the sheet consumes
 * (scrolls to the row, then clears).
 */
export type TreeState = { open: boolean; dirs: string[]; reveal: string | null };

const ancestors = (p: string): string[] => {
  const parts = p.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
};

export const treeSlice = createSlice({
  name: 'tree',
  initialState: (): TreeState => ({ open: false, dirs: [], reveal: null }),
  reducers: {
    /** Opens the sheet and expands every ancestor of the path. */
    reveal: (s, a: PayloadAction<string>) => {
      s.open = true;
      s.reveal = a.payload;
      for (const d of ancestors(a.payload)) if (!s.dirs.includes(d)) s.dirs.push(d);
    },
    clearReveal: (s) => void (s.reveal = null),
    setTreeOpen: (s, a: PayloadAction<boolean>) => void (s.open = a.payload),
    toggleDir: (s, a: PayloadAction<string>) => {
      s.dirs = s.dirs.includes(a.payload) ? s.dirs.filter((d) => d !== a.payload) : [...s.dirs, a.payload];
    },
    /** Replace the expanded set (restore from storage, or drop folders that vanished). */
    setDirs: (s, a: PayloadAction<string[]>) => void (s.dirs = a.payload),
  },
});

export const revealInTree = treeSlice.actions.reveal;
export const { clearReveal, setTreeOpen, toggleDir, setDirs } = treeSlice.actions;

export const selectTree = (s: RootState): TreeState => s.tree;

export const treeKey = (root: string) => `tree:${root}`;
export function readSavedDirs(root: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(treeKey(root)) ?? 'null');
    return Array.isArray(v) && v.every((p: unknown) => typeof p === 'string') ? v : null;
  } catch {
    return null;
  }
}
