import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { orderedTasks, reduceTasks, type Task, type TasksState } from '@nota-bene/shared';
import { serverEvent, type AppThunk, type RootState } from '../store/store.ts';

export type { Task, TasksState } from '@nota-bene/shared';

export const tasksSlice = createSlice({
  name: 'tasks',
  initialState: {} as TasksState,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (s, a) => reduceTasks(s as TasksState, a.payload)),
});

/** The first protocol whose server takes `task-stop` / `task-background` and serves `/task-output`: below it the controls are absent, not disabled. */
export const TASKS_PROTOCOL = 8;

/** The drawer's state: only whether it is open (the rows come from `tasks`). */
export const tasksUiSlice = createSlice({
  name: 'tasksUi',
  initialState: { open: false },
  reducers: {
    setDrawer: (s, a: PayloadAction<boolean>) => void (s.open = a.payload),
    toggleDrawer: (s) => void (s.open = !s.open),
  },
});
export const { setDrawer, toggleDrawer } = tasksUiSlice.actions;
export const selectDrawerOpen = (s: RootState): boolean => s.tasksUi.open;

/** The tool-use ids of the Agent calls whose task is still running (the card's "running"). */
export const selectLiveCalls = createSelector([(s: RootState) => s.tasks], (t): ReadonlySet<string> =>
  new Set(Object.values(t).flatMap((x) => (x.call && x.status === 'running' ? [x.call] : []))));

export const selectTasks = (s: RootState): TasksState => s.tasks;
/** How many tasks run (what the indicator, the pulse and the favicon count). */
export const selectRunningCount = createSelector([selectTasks], (t) => Object.values(t).filter((x) => x.status === 'running').length);
export const selectFinishedCount = createSelector([selectTasks], (t) => Object.values(t).filter((x) => x.status !== 'running').length);

export type TaskRow = { id: string; task: Task; depth: number };
/**
 * The drawer's rows: the running tasks (oldest first) then the finished (newest ended first); a task that has a known
 * parent task is nested under it (`depth` 1+), whatever its own status; one whose parent is unknown (never started here,
 * or pushed out by the cap) stands on its own.
 */
export const selectTaskRows = createSelector([selectTasks], (t): TaskRow[] => {
  const ordered = orderedTasks(t);
  const kids = new Map<string, [string, Task][]>();
  for (const e of ordered) {
    const p = e[1].parent;
    if (p && p !== e[0] && t[p]) kids.set(p, [...(kids.get(p) ?? []), e]);
  }
  const rows: TaskRow[] = [];
  const seen = new Set<string>();
  const walk = (e: [string, Task], depth: number) => {
    if (seen.has(e[0])) return; // a parent cycle (never sent) must not loop
    seen.add(e[0]);
    rows.push({ id: e[0], task: e[1], depth });
    for (const c of kids.get(e[0]) ?? []) walk(c, depth + 1);
  };
  for (const e of ordered) if (!e[1].parent || e[1].parent === e[0] || !t[e[1].parent]) walk(e, 0);
  return rows;
});

/** The running task started by the tool call `call`, if any. */
export const selectTaskByCall = (s: RootState, call: string): { id: string; task: Task } | undefined => {
  const e = Object.entries(s.tasks).find(([, x]) => x.call === call && x.status === 'running');
  return e && { id: e[0], task: e[1] };
};

/** The server understands the task controls (stop, to background, shell output). */
export const selectTaskControls = (s: RootState): boolean => s.controls.protocol >= TASKS_PROTOCOL;

export const stopTask = (id: string): AppThunk => (_d, getState, { send }) => {
  if (selectTaskControls(getState())) send({ type: 'task-stop', id });
};
export const backgroundTask = (toolUseId: string): AppThunk => (_d, getState, { send }) => {
  if (selectTaskControls(getState())) send({ type: 'task-background', toolUseId });
};
