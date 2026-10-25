import { createSlice } from '@reduxjs/toolkit';
import type { Stats } from '@nota-bene/shared';
import { serverEvent, type RootState } from '../store/store.ts';

/** null until the first `stats` event. Each event replaces the whole slice (its null parts mean "unknown"). */
export const statsSlice = createSlice({
  name: 'stats',
  initialState: null as Stats | null,
  reducers: {},
  extraReducers: (b) =>
    b.addCase(serverEvent, (s, a) => (a.payload.kind === 'stats' ? a.payload.stats : s)),
});

export const selectStats = (s: RootState): Stats | null => s.stats;
