import type { ServerEvent } from './protocol.ts';

// The web's task reducer (tasks/slice.ts), here so the server can check that what it keeps in the hub across a
// compaction replays to the same state (R-M7-12). Pure: no web dependency.

export type Task = { desc: string; type: string; /** the tool-use id of the call that started it, when the CLI said */ call?: string; start: number; tokens: number; tool: string; summary: string };
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
      return { ...s, [e.id]: { desc: e.desc ?? 'task', type: e.type ?? '', ...(e.call ? { call: e.call } : {}), start: ev.ts, tokens: 0, tool: '', summary: '' } };
    case 'progress':
      return cur ? { ...s, [e.id]: { ...cur, tokens: e.tokens || 0, tool: e.tool || '', summary: e.summary || '' } } : s;
    case 'updated':
      return cur && e.desc ? { ...s, [e.id]: { ...cur, desc: e.desc } } : s;
    case 'done':
      return cur ? without(s, e.id) : s;
  }
}
