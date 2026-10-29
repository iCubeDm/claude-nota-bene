import { expect, it } from 'vitest';
import type { WireAgentEvent } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectFinishedCount, selectRunningCount, selectTaskByCall, selectTaskRows } from './slice.ts';

type Task = Extract<WireAgentEvent, { t: 'task' }>;
function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  let ts = 0;
  const task = (e: Task) => store.dispatch(serverEvent({ kind: 'agent', e, ts: ++ts }));
  return { store, task };
}
const start = (id: string, extra: Partial<Task> = {}): Task => ({ t: 'task', phase: 'started', id, desc: id, type: 'local_bash', ...extra });
const done = (id: string, status?: 'failed' | 'stopped'): Task => ({ t: 'task', phase: 'done', id, ...(status ? { status } : {}) });

it('counts: running and finished apart; a finished task leaves the running count but stays listed', () => {
  const { store, task } = setup();
  task(start('a')); task(start('b')); task(done('a'));
  expect(selectRunningCount(store.getState())).toBe(1);
  expect(selectFinishedCount(store.getState())).toBe(1);
  expect(store.getState().tasks.a).toMatchObject({ status: 'done' });
});

it('rows: running first (oldest first), then finished newest first', () => {
  const { store, task } = setup();
  task(start('a')); task(start('b')); task(start('c')); task(done('a')); task(done('c', 'failed'));
  expect(selectTaskRows(store.getState()).map((r) => `${r.id}:${r.task.status}`)).toEqual(['b:running', 'c:failed', 'a:done']);
});

it('rows: a task with a known parent is nested under it; an unknown parent stands alone; a cycle does not loop', () => {
  const { store, task } = setup();
  task(start('p', { type: 'local_agent' }));
  task(start('k1', { parent: 'p' }));
  task(start('k2', { parent: 'p' }));
  task(start('o', { parent: 'gone' }));
  task(start('x', { parent: 'y' }));
  task(start('y', { parent: 'x' }));
  expect(selectTaskRows(store.getState()).map((r) => `${r.depth}${r.id}`)).toEqual(['0p', '1k1', '1k2', '0o']);
});

it('a finished child stays under its running parent', () => {
  const { store, task } = setup();
  task(start('p', { type: 'local_agent' })); task(start('k', { parent: 'p' })); task(done('k'));
  expect(selectTaskRows(store.getState()).map((r) => `${r.depth}${r.id}`)).toEqual(['0p', '1k']);
});

it('selectTaskByCall finds the running task of a call only', () => {
  const { store, task } = setup();
  task(start('a', { call: 'toolu_A' }));
  expect(selectTaskByCall(store.getState(), 'toolu_A')?.id).toBe('a');
  task(done('a'));
  expect(selectTaskByCall(store.getState(), 'toolu_A')).toBeUndefined();
});
