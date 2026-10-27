import { createSlice } from '@reduxjs/toolkit';
import { reduceTasks, type TasksState } from '@nota-bene/shared';
import { serverEvent, type RootState } from '../store/store.ts';

export type { Task, TasksState } from '@nota-bene/shared';

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

export const selectTasks = (s: RootState): TasksState => s.tasks;
