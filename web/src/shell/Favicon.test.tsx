import { act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { connState, makeStore, serverEvent } from '@/store/store.ts';
import { startFavicon, FAV } from './Favicon.ts';

let stop = () => {};
let focused = true;
let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
  focused = true; hidden = false;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});
afterEach(() => { stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

const sdk = (m: Record<string, unknown>): ServerEvent => ({ kind: 'sdk', ts: 1, m } as unknown as ServerEvent);
const user: ServerEvent = { kind: 'user', id: 'u1', text: 'hi', ts: 1 } as ServerEvent;
const perm = (id: string): ServerEvent => ({ kind: 'permission', id, toolName: 'Bash', input: {}, ts: 2 } as unknown as ServerEvent);
const result: ServerEvent = sdk({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, user_message_uuids: ['u1'] });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  stop = startFavicon(store);
  const ev = (e: ServerEvent) => act(() => { store.dispatch(serverEvent(e)); });
  const fill = () => {
    const href = document.querySelector('link[rel="icon"]')!.getAttribute('href')!;
    return /fill="(#[0-9a-f]{6})"/.exec(decodeURIComponent(href))![1];
  };
  return { ev, fill, store };
}

it('draws the prototype shape as a data URL on link[rel=icon], idle first', () => {
  const { fill } = setup();
  const href = document.querySelector('link[rel="icon"]')!.getAttribute('href')!;
  expect(href).toMatch(/^data:image\/svg\+xml,/);
  expect(decodeURIComponent(href)).toContain('M7.5 21.5v-11l6.5 11v-11');
  expect(fill()).toBe(FAV.idle);
});

it('work blinks every 700 ms; a result stops it', () => {
  const { ev, fill } = setup();
  ev(user);
  expect(fill()).toBe(FAV.workHi);
  act(() => void vi.advanceTimersByTime(700));
  expect(fill()).toBe(FAV.work);
  act(() => void vi.advanceTimersByTime(700));
  expect(fill()).toBe(FAV.workHi);
  ev(result);
  expect(fill()).toBe(FAV.idle);
  expect(vi.getTimerCount()).toBe(0);
});

it('priority: a question for the user beats work; answering returns to work', () => {
  const { ev, fill } = setup();
  ev(user);
  ev(perm('p1'));
  expect(fill()).toBe(FAV.ask);
  act(() => void vi.advanceTimersByTime(700));
  expect(fill()).toBe(FAV.ask);
  ev({ kind: 'permission-done', id: 'p1', allow: true, ts: 3 } as unknown as ServerEvent);
  expect([FAV.workHi, FAV.work]).toContain(fill());
});

it('done only when a live result lands while hidden or unfocused; focus clears it', () => {
  const { ev, fill } = setup();
  ev(user);
  ev(result);
  expect(fill()).toBe(FAV.idle); // focused: nothing to announce
  focused = false;
  ev({ kind: 'user', id: 'u2', text: 'again', ts: 2 } as ServerEvent);
  ev(sdk({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, user_message_uuids: ['u2'] }));
  expect(fill()).toBe(FAV.done);
  focused = true;
  act(() => void window.dispatchEvent(new Event('focus')));
  expect(fill()).toBe(FAV.idle);
  hidden = true;
  ev({ kind: 'user', id: 'u3', text: 'x', ts: 3 } as ServerEvent);
  ev(sdk({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, user_message_uuids: ['u3'] }));
  expect(fill()).toBe(FAV.done);
  hidden = false;
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
  expect(fill()).toBe(FAV.idle);
});

it('a replayed result never lights done', () => {
  const { ev, fill } = setup();
  focused = false;
  ev({ kind: 'replay', events: [user, result] } as ServerEvent);
  expect(fill()).toBe(FAV.idle);
});

it('a background task (subagent, shell) keeps it working after the turn ends; done only once the task ends', () => {
  const { ev, fill } = setup();
  ev(user);
  ev(sdk({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'review' }));
  focused = false;
  ev(result); // the main turn ended while away, the subagent still runs
  expect(fill()).toBe(FAV.workHi);
  act(() => void vi.advanceTimersByTime(700));
  expect(fill()).toBe(FAV.work);
  ev(sdk({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' }));
  expect(fill()).toBe(FAV.done);
  expect(vi.getTimerCount()).toBe(0);
});

it('five distinct colours: idle neutral, work two oranges, a question blue, done green, error red', () => {
  expect(new Set([FAV.idle, FAV.work, FAV.workHi, FAV.ask, FAV.done, FAV.error]).size).toBe(6);
});

it('a turn that failed while away is red until seen; a dropped connection is red while it lasts', () => {
  const { ev, fill, store } = setup();
  focused = false;
  ev(user);
  ev(sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 5, errors: ['boom'], user_message_uuids: ['u1'] }));
  expect(fill()).toBe(FAV.error);
  focused = true;
  act(() => void window.dispatchEvent(new Event('focus')));
  expect(fill()).toBe(FAV.idle);
  act(() => { store.dispatch(connState('open')); store.dispatch(connState('closed')); });
  expect(fill()).toBe(FAV.error); // even while looking at it: nothing works until it reconnects
  act(() => { store.dispatch(connState('open')); });
  expect(fill()).toBe(FAV.idle);
});
