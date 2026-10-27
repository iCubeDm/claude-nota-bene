import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent, WireAgentEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { TasksLine, fmtElapsed } from './TasksLine.tsx';

beforeEach(() => { setLang('en'); vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><TasksLine /></Provider>);
  const task = (e: Task, ts = Date.now()) => act(() => { store.dispatch(serverEvent({ kind: 'agent', e, ts })); });
  return { store, task };
}
type Task = Extract<WireAgentEvent, { t: 'task' }>;
const started = (extra: Partial<Task> = {}): Task => ({ t: 'task', phase: 'started', id: 't1', desc: 'Explore repo', type: '', ...extra });
const done = (id: string): Task => ({ t: 'task', id, phase: 'done' });

it('started -> progress -> notification lifecycle', () => {
  const { task } = setup();
  expect(screen.queryByText('Explore repo')).toBeNull();
  task(started());
  expect(screen.getByText('Explore repo')).toBeInTheDocument();
  expect(screen.getByText('0s')).toBeInTheDocument();
  task({ t: 'task', id: 't1', phase: 'progress', tokens: 45678, tool: 'Grep', summary: 'looking' });
  expect(screen.getByText('0s · 46k tok · Grep')).toBeInTheDocument();
  expect(screen.getByTitle('looking')).toBeInTheDocument();
  task(done('t1'));
  expect(screen.queryByText('Explore repo')).toBeNull();
});

// the description fallbacks (subagent_type, task_type) and skipping ambient / transcript-less tasks are the mapper's (map.test.ts)
it('a started task without a description shows as task', () => {
  const { task } = setup();
  task({ t: 'task', id: 'c', phase: 'started' });
  expect(screen.getByText('task')).toBeInTheDocument();
});

it('updated renames, done removes; both ignore an unknown id', () => {
  const { task, store } = setup();
  task(started());
  task({ t: 'task', id: 't1', phase: 'updated', desc: 'Renamed' });
  expect(screen.getByText('Renamed')).toBeInTheDocument();
  const before = store.getState().tasks;
  task({ t: 'task', id: 'zz', phase: 'progress', tokens: 1 });
  task({ t: 'task', id: 'zz', phase: 'updated', desc: 'Ghost' });
  task(done('zz'));
  expect(store.getState().tasks).toBe(before);
  task(done('t1'));
  expect(screen.queryByText('Renamed')).toBeNull();
});

it('a replay resets, and replayed task events rebuild with the true elapsed time', () => {
  const { task, store } = setup();
  task(started());
  act(() => { store.dispatch(serverEvent({ kind: 'replay', events: [] } as unknown as ServerEvent)); });
  expect(screen.queryByText('Explore repo')).toBeNull();
  const ev: ServerEvent = { kind: 'agent', e: started({ id: 'r', desc: 'Replayed' }), ts: Date.now() - 65_000 };
  act(() => { store.dispatch(serverEvent({ kind: 'replay', events: [ev] } as unknown as ServerEvent)); });
  expect(screen.getByText('Replayed')).toBeInTheDocument();
  expect(screen.getByText('1:05')).toBeInTheDocument();
});

it('elapsed formatting: Ns under a minute, else m:ss', () => {
  expect(fmtElapsed(0)).toBe('0s');
  expect(fmtElapsed(59_400)).toBe('59s');
  expect(fmtElapsed(60_000)).toBe('1:00');
  expect(fmtElapsed(125_000)).toBe('2:05');
  expect(fmtElapsed(-5000)).toBe('0s');
});

it('ticks once per second while live; the interval stops when the list is empty', () => {
  const { task } = setup();
  expect(vi.getTimerCount()).toBe(0);
  task(started());
  expect(vi.getTimerCount()).toBe(1);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(screen.getByText('3s')).toBeInTheDocument();
  task(started({ id: 't2' }));
  expect(vi.getTimerCount()).toBe(1);
  task(done('t1'));
  task(done('t2'));
  expect(vi.getTimerCount()).toBe(0);
});

it('unmount clears the interval', () => {
  const { task } = setup();
  task(started());
  expect(vi.getTimerCount()).toBe(1);
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

it('a reset (/clear) drops the live tasks', () => {
  const { store } = setup();
  act(() => { store.dispatch(serverEvent({ kind: 'agent', e: started(), ts: Date.now() })); });
  expect(screen.getByText('Explore repo')).toBeInTheDocument();
  act(() => { store.dispatch(serverEvent({ kind: 'agent', e: { t: 'reset', newId: 'n' }, ts: Date.now() })); });
  expect(screen.queryByText('Explore repo')).toBeNull();
});
