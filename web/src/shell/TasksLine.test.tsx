import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { TasksLine, fmtElapsed } from './TasksLine.tsx';

beforeEach(() => { setLang('en'); vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><TasksLine /></Provider>);
  const sdk = (m: Record<string, unknown>, ts = Date.now()) => act(() => { store.dispatch(serverEvent({ kind: 'sdk', m, ts } as unknown as ServerEvent)); });
  return { store, sdk };
}
const started = (extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'Explore repo', ...extra });

it('started -> progress -> notification lifecycle', () => {
  const { sdk } = setup();
  expect(screen.queryByText('Explore repo')).toBeNull();
  sdk(started());
  expect(screen.getByText('Explore repo')).toBeInTheDocument();
  expect(screen.getByText('0s')).toBeInTheDocument();
  sdk({ type: 'system', subtype: 'task_progress', task_id: 't1', usage: { total_tokens: 45678 }, last_tool_name: 'Grep', summary: 'looking' });
  expect(screen.getByText('0s · 46k tok · Grep')).toBeInTheDocument();
  expect(screen.getByTitle('looking')).toBeInTheDocument();
  sdk({ type: 'system', subtype: 'task_notification', task_id: 't1' });
  expect(screen.queryByText('Explore repo')).toBeNull();
});

it('desc falls back to subagent_type, task_type, then task', () => {
  const { sdk } = setup();
  sdk(started({ task_id: 'a', description: '', subagent_type: 'general' }));
  sdk(started({ task_id: 'b', description: '', task_type: 'shell' }));
  sdk(started({ task_id: 'c', description: '' }));
  for (const d of ['general', 'shell', 'task']) expect(screen.getByText(d)).toBeInTheDocument();
});

it('ambient and skip_transcript tasks are skipped', () => {
  const { sdk } = setup();
  sdk(started({ ambient: true }));
  sdk(started({ task_id: 't2', skip_transcript: true }));
  expect(screen.queryByText('Explore repo')).toBeNull();
});

it('task_updated: terminal status removes, otherwise updates desc', () => {
  const { sdk } = setup();
  sdk(started());
  sdk({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running', description: 'Renamed' } });
  expect(screen.getByText('Renamed')).toBeInTheDocument();
  sdk({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed' } });
  expect(screen.queryByText('Renamed')).toBeNull();
});

it('a replay resets, and replayed task events rebuild with the true elapsed time', () => {
  const { sdk, store } = setup();
  sdk(started());
  act(() => { store.dispatch(serverEvent({ kind: 'replay', events: [] } as unknown as ServerEvent)); });
  expect(screen.queryByText('Explore repo')).toBeNull();
  const ev = { kind: 'sdk', m: started({ task_id: 'r' , description: 'Replayed' }), ts: Date.now() - 65_000 };
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
  const { sdk } = setup();
  expect(vi.getTimerCount()).toBe(0);
  sdk(started());
  expect(vi.getTimerCount()).toBe(1);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(screen.getByText('3s')).toBeInTheDocument();
  sdk(started({ task_id: 't2' }));
  expect(vi.getTimerCount()).toBe(1);
  sdk({ type: 'system', subtype: 'task_notification', task_id: 't1' });
  sdk({ type: 'system', subtype: 'task_notification', task_id: 't2' });
  expect(vi.getTimerCount()).toBe(0);
});

it('unmount clears the interval', () => {
  const { sdk } = setup();
  sdk(started());
  expect(vi.getTimerCount()).toBe(1);
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});
