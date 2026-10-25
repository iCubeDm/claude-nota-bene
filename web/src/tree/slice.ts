import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/** `reveal` is a request (project-relative path) that the tree consumes in M3-07; the tab strip only raises it. */
export type TreeState = { open: boolean; reveal: string | null };

export const treeSlice = createSlice({
  name: 'tree',
  initialState: (): TreeState => ({ open: false, reveal: null }),
  reducers: {
    reveal: (s, a: PayloadAction<string>) => void (s.reveal = a.payload),
  },
});

export const revealInTree = treeSlice.actions.reveal;
