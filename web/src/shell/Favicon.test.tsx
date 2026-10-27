import { act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
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

const turnEnd = (id: string): ServerEvent => ({ kind: 'agent', ts: 1, e: { t: 'turn-end', stop: 'done', secs: 0, answers: [id], queued: 0 } });
const user: ServerEvent = { kind: 'user', id: 'u1', text: 'hi', ts: 1 } as ServerEvent;
const perm = (id: string): ServerEvent => ({ kind: 'permission', id, toolName: 'Bash', input: {}, ts: 2 } as unknown as ServerEvent);
const result: ServerEvent = turnEnd('u1');

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

it('priority: wait beats work; answering returns to work', () => {
  const { ev, fill } = setup();
  ev(user);
  ev(perm('p1'));
  expect(fill()).toBe(FAV.wait);
  act(() => void vi.advanceTimersByTime(700));
  expect(fill()).toBe(FAV.wait);
  ev({ kind: 'permission-done', id: 'p1', allow: true, ts: 3 } as unknown as ServerEvent);
  expect(['#f0761f', '#8b6cf2']).toContain(fill());
});

it('done only when a live result lands while hidden or unfocused; focus clears it', () => {
  const { ev, fill } = setup();
  ev(user);
  ev(result);
  expect(fill()).toBe(FAV.idle); // focused: nothing to announce
  focused = false;
  ev({ kind: 'user', id: 'u2', text: 'again', ts: 2 } as ServerEvent);
  ev(turnEnd('u2'));
  expect(fill()).toBe(FAV.done);
  focused = true;
  act(() => void window.dispatchEvent(new Event('focus')));
  expect(fill()).toBe(FAV.idle);
  hidden = true;
  ev({ kind: 'user', id: 'u3', text: 'x', ts: 3 } as ServerEvent);
  ev(turnEnd('u3'));
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
