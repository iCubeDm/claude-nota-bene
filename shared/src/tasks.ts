import type { ServerEvent } from './protocol.ts';

// The web's task reducer (tasks/slice.ts), here so the server can check that what it keeps in the hub across a
// compaction replays to the same state (R-M7-12). Pure: no web dependency.

export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped';
/** `agent`: a subagent; `shell`: a background shell or Monitor (has an output to read); `other`: workflows and the rest */
export type TaskKind = 'agent' | 'shell' | 'other';

export type Task = {
  desc: string; type: string; kind: TaskKind;
  /** the tool-use id of the call that started it, when the CLI said */ call?: string;
  /** task_id of the subagent task that launched it, when the CLI said */ parent?: string;
  /** the CLI's `is_backgrounded`: false = blocks its tool call, true = in the background; absent = not said */ bg?: boolean;
  /** a live-update watcher: listed, but not counted as activity */ ambient?: boolean;
  start: number; status: TaskStatus; /** the server time the task ended; only once it is not running */ end?: number;
  tokens: number; tool: string; summary: string;
};
/** task_id -> task, the running ones and the last FINISHED_CAP finished. Rebuilt from replayed task events, so a reload mid-task still shows it. */
export type TasksState = Record<string, Task>;

/** the most finished tasks kept (the oldest ended go first) */
export const FINISHED_CAP = 20;

/** The task's kind from the CLI's task_type (local_agent, remote_agent, local_bash, monitor_mcp, ...); no type but a call: an agent. */
export function taskKind(type: string, call?: string): TaskKind {
  if (/agent/.test(type)) return 'agent';
  if (/bash|shell|monitor/.test(type)) return 'shell';
  return !type && call ? 'agent' : 'other';
}

const without = (s: TasksState, ids: string[]): TasksState => {
  const rest = { ...s };
  for (const id of ids) delete rest[id];
  return rest;
};

/** The running tasks, oldest first, then the finished, newest ended first (the drawer's order of rows). */
export function orderedTasks(s: TasksState): [string, Task][] {
  const all = Object.entries(s);
  return [
    ...all.filter(([, t]) => t.status === 'running').sort((a, b) => a[1].start - b[1].start),
    ...all.filter(([, t]) => t.status !== 'running').sort((a, b) => (b[1].end ?? 0) - (a[1].end ?? 0)),
  ];
}

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
    case 'started': {
      const type = e.type ?? '';
      // another start of a known id is a RESUME (SendMessage to a finished agent): its tool_use_id is the SendMessage call,
      // but the subagent's files are known by the original call, so the original `call` (and parent / bg) stays
      const call = cur?.call ?? e.call;
      const parent = cur?.parent ?? e.parent;
      const bg = e.bg ?? cur?.bg;
      return {
        ...s,
        [e.id]: {
          desc: e.desc ?? 'task', type, kind: taskKind(type, call), ...(call ? { call } : {}), ...(parent ? { parent } : {}),
          ...(bg !== undefined ? { bg } : {}), ...(e.ambient ? { ambient: true } : {}),
          start: ev.ts, status: 'running', tokens: 0, tool: '', summary: '',
        },
      };
    }
    case 'progress':
      return cur?.status === 'running' ? { ...s, [e.id]: { ...cur, tokens: e.tokens || 0, tool: e.tool || '', summary: e.summary || '' } } : s;
    case 'updated':
      return cur && (e.desc || e.bg !== undefined) ? { ...s, [e.id]: { ...cur, ...(e.desc ? { desc: e.desc } : {}), ...(e.bg !== undefined ? { bg: e.bg } : {}) } } : s;
    case 'done': {
      if (cur?.status !== 'running') return s; // unknown, or already over (the CLI reports an end twice: update, then notification)
      const next = { ...s, [e.id]: { ...cur, status: e.status ?? 'done', end: ev.ts } as Task };
      const finished = Object.entries(next).filter(([, t]) => t.status !== 'running');
      if (finished.length <= FINISHED_CAP) return next;
      const drop = finished.sort((a, b) => (a[1].end ?? 0) - (b[1].end ?? 0)).slice(0, finished.length - FINISHED_CAP).map(([id]) => id);
      return without(next, drop);
    }
  }
}
