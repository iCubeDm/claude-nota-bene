import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AppThunk, RootState } from '../store/store.ts';

/**
 * `open`: the sheet. `src`: the source it shows ('here', 'ref:<branch>', 'dir:<hash>'; M3-16). `dirs`: expanded folders of
 * that source (project-relative, '/'-joined; each source keeps its own set in storage). `reveal`: a request the sheet
 * consumes (scrolls to the row, then clears).
 */
export type TreeState = { open: boolean; src: string; dirs: string[]; reveal: string | null };

const ancestors = (p: string): string[] => {
  const parts = p.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
};

export const treeSlice = createSlice({
  name: 'tree',
  initialState: (): TreeState => ({ open: false, src: 'here', dirs: [], reveal: null }),
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
    /** Switch the shown source together with its own expanded folders. */
    setSource: (s, a: PayloadAction<{ id: string; dirs: string[] }>) => {
      s.src = a.payload.id;
      s.dirs = a.payload.dirs;
      s.reveal = null;
    },
  },
});

export const revealInTree = treeSlice.actions.reveal;
export const { clearReveal, setTreeOpen, toggleDir, setDirs, setSource } = treeSlice.actions;

export const selectTree = (s: RootState): TreeState => s.tree;

/** `tree:<root>` for this folder (unchanged since M3-07), `tree:<root>:<src>` for another source. */
export const treeKey = (root: string, src = 'here') => (src === 'here' ? `tree:${root}` : `tree:${root}:${src}`);
export function readSavedDirs(root: string, src = 'here'): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(treeKey(root, src)) ?? 'null');
    return Array.isArray(v) && v.every((p: unknown) => typeof p === 'string') ? v : null;
  } catch {
    return null;
  }
}

/** Show another source in the tree, with the folders that were open there last time. */
export const pickSource = (id: string): AppThunk => (d, getState) => {
  const st = getState();
  if (st.tree.src === id) return;
  const root = st.feed.session?.root;
  d(setSource({ id, dirs: (root && readSavedDirs(root, id)) || [] }));
};

/** "Reveal in tree" for a file tab: switches the tree to the tab's source first. */
export const revealFile = (path: string, src = 'here'): AppThunk => (d) => {
  d(pickSource(src));
  d(revealInTree(path));
};
