import { createSelector, createSlice } from '@reduxjs/toolkit';
import { reduceTasks, type TasksState } from '@nota-bene/shared';
import { serverEvent, type RootState } from '../store/store.ts';

export type { Task, TasksState } from '@nota-bene/shared';

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

/** The tool-use ids of the Agent calls whose task is still live (the card's "running"). */
export const selectLiveCalls = createSelector([(s: RootState) => s.tasks], (t): ReadonlySet<string> =>
  new Set(Object.values(t).flatMap((x) => (x.call ? [x.call] : []))));

export const selectTasks = (s: RootState): TasksState => s.tasks;
