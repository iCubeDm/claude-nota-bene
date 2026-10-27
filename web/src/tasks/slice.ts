import { createSlice } from '@reduxjs/toolkit';
import type { ServerEvent } from '@nota-bene/shared';
import { serverEvent, type RootState } from '../store/store.ts';

export type Task = { desc: string; type: string; start: number; tokens: number; tool: string; summary: string };
/** task_id -> live task. Rebuilt from replayed task events, so a reload mid-task still shows it. */
export type TasksState = Record<string, Task>;

const without = (s: TasksState, id: string): TasksState => {
  const { [id]: _gone, ...rest } = s;
  return rest;
};

/** Pure; follows the prototype's onTask. `ts` is the server event time, so elapsed survives a reload. */
export function reduceTasks(s: TasksState, ev: ServerEvent): TasksState {
  if (ev.kind === 'replay') return ev.events.reduce(reduceTasks, {});
  if (ev.kind !== 'agent') return s;
  const e = ev.e;
  if (e.t === 'reset') return Object.keys(s).length ? {} : s;
  if (e.t !== 'task') return s;
  const cur = s[e.id];
  switch (e.phase) {
    // the mapper drops ambient and transcript-less tasks and fills the description fallbacks
    case 'started':
      return { ...s, [e.id]: { desc: e.desc ?? 'task', type: e.type ?? '', start: ev.ts, tokens: 0, tool: '', summary: '' } };
    case 'progress':
      return cur ? { ...s, [e.id]: { ...cur, tokens: e.tokens || 0, tool: e.tool || '', summary: e.summary || '' } } : s;
    case 'updated':
      return cur && e.desc ? { ...s, [e.id]: { ...cur, desc: e.desc } } : s;
    case 'done':
      return cur ? without(s, e.id) : s;
  }
}

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

export const selectTasks = (s: RootState): TasksState => s.tasks;
