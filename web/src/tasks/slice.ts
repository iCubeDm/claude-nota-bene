import { createSlice } from '@reduxjs/toolkit';
import type { ServerEvent } from '@nota-bene/shared';
import { serverEvent, type RootState } from '../store/store.ts';

export type Task = { desc: string; type: string; start: number; tokens: number; tool: string; summary: string };
/** task_id -> live task. Rebuilt from replayed task events, so a reload mid-task still shows it. */
export type TasksState = Record<string, Task>;

type TaskMsg = {
  type?: string; subtype?: string; task_id?: string;
  description?: string; subagent_type?: string; task_type?: string; ambient?: boolean; skip_transcript?: boolean;
  usage?: { total_tokens?: number }; last_tool_name?: string; summary?: string;
  patch?: { status?: string; description?: string };
};

const without = (s: TasksState, id: string): TasksState => {
  const { [id]: _gone, ...rest } = s;
  return rest;
};

/** Pure; follows the prototype's onTask. `ts` is the server event time, so elapsed survives a reload. */
export function reduceTasks(s: TasksState, ev: ServerEvent): TasksState {
  if (ev.kind === 'replay') return ev.events.reduce(reduceTasks, {});
  if (ev.kind !== 'sdk') return s;
  const m = ev.m as unknown as TaskMsg;
  if (m.type === 'conversation_reset') return Object.keys(s).length ? {} : s;
  if (m.type !== 'system' || !m.task_id) return s;
  const id = m.task_id;
  const cur = s[id];
  switch (m.subtype) {
    case 'task_started':
      if (m.ambient || m.skip_transcript) return s;
      return { ...s, [id]: { desc: m.description || m.subagent_type || m.task_type || 'task', type: m.task_type ?? '', start: ev.ts, tokens: 0, tool: '', summary: '' } };
    case 'task_progress':
      return cur ? { ...s, [id]: { ...cur, tokens: m.usage?.total_tokens || 0, tool: m.last_tool_name || '', summary: m.summary || '' } } : s;
    case 'task_updated': {
      if (!cur) return s;
      const st = m.patch?.status;
      if (st && st !== 'running' && st !== 'pending' && st !== 'paused') return without(s, id);
      return m.patch?.description ? { ...s, [id]: { ...cur, desc: m.patch.description } } : s;
    }
    case 'task_notification':
      return cur ? without(s, id) : s;
    default:
      return s;
  }
}

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

export const selectTasks = (s: RootState): TasksState => s.tasks;
