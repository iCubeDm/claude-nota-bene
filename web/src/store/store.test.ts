import { afterEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { devToolsEnabled, interrupt, makeStore, selectBusy, selectFeed, sendMessage } from './store.ts';

function fake() {
  const sent: ClientMessage[] = [];
  let onEvent!: (e: ServerEvent) => void;
  let onState!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: string, e: typeof onEvent, s: typeof onState) => {
    onEvent = e;
    onState = s;
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  return { sent, connect, ev: (e: ServerEvent) => onEvent(e), state: (s: 'open' | 'closed') => onState(s) };
}

afterEach(() => vi.unstubAllEnvs());

it('inbound frames reach the feed', () => {
  const f = fake();
  const store = makeStore({ url: 'ws://x/ws', connect: f.connect });
  expect(f.connect).toHaveBeenCalledTimes(1);
  f.ev({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  expect(selectBusy(store.getState())).toBe(true);
  f.ev({ kind: 'sdk', ts: 2, m: { type: 'result', subtype: 'success', duration_ms: 5, is_error: false, result: 'ok', user_message_uuid: 'u1' } as never });
  expect(selectBusy(store.getState())).toBe(false);
  expect(selectFeed(store.getState()).items).toHaveLength(2);
});

it('sendMessage returns false while closed', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  expect(store.dispatch(sendMessage('hi', false))).toBe(false);
  expect(f.sent).toEqual([]);
  f.state('open');
  expect(store.dispatch(sendMessage('hi', true))).toBe(true);
  expect(f.sent[0]).toMatchObject({ type: 'send', text: 'hi', force: false }); // idle: force dropped
});

it('interrupt while idle sends nothing', () => {
  const f = fake();
  const store = makeStore({ url: 'u', connect: f.connect });
  f.state('open');
  store.dispatch(interrupt());
  expect(f.sent).toEqual([]);
});

it('devtools only in dev', () => {
  vi.stubEnv('DEV', true);
  expect(devToolsEnabled()).toBe(true);
  vi.stubEnv('DEV', false);
  expect(devToolsEnabled()).toBe(false);
});
