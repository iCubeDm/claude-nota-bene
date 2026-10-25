import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';

/** The composer's draft lives in the store so the comments panel's send can include it. */
export const composerSlice = createSlice({
  name: 'composer',
  initialState: { draft: '' },
  reducers: { setDraft: (s, a: PayloadAction<string>) => void (s.draft = a.payload) },
});

export const { setDraft } = composerSlice.actions;
export const selectDraft = (s: RootState): string => s.composer.draft;
