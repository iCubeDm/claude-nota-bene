import { afterEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { ACTIVITY_THROTTLE_MS, reportActivity, resetActivityThrottle } from './slice.ts';

afterEach(resetActivityThrottle);

function setup(open = true) {
  const sent: ClientMessage[] = [];
  const connect = vi.fn(() => ({ send: (m: ClientMessage) => (open ? (sent.push(m), true) : false), close() {} }));
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  store.dispatch(serverEvent({ kind: 'hello', protocol: 2 }));
  return { sent, store };
}

it('sends activity at most once per throttle window', () => {
  const { sent, store } = setup();
  store.dispatch(reportActivity(1000));
  store.dispatch(reportActivity(2000));
  store.dispatch(reportActivity(1000 + ACTIVITY_THROTTLE_MS - 1));
  expect(sent).toEqual([{ type: 'activity' }]);
  store.dispatch(reportActivity(1000 + ACTIVITY_THROTTLE_MS));
  expect(sent).toHaveLength(2);
});

it('a send that did not go out (offline) is tried again at the next activity', () => {
  const off = setup(false);
  off.store.dispatch(reportActivity(1000));
  const on = setup();
  on.store.dispatch(reportActivity(1001));
  expect(on.sent).toEqual([{ type: 'activity' }]);
});

it('an older server (no hello) never gets activity: it would answer with an error toast', () => {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  store.dispatch(reportActivity(1000));
  expect(sent).toEqual([]);
});
