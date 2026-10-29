import { expect, it } from 'vitest';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectLiveCalls } from './slice.ts';

it('the live calls are the call ids of the running tasks; a finished one (still listed) leaves', () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const ag = (e: object) => serverEvent({ kind: 'agent', ts: 1, e } as never);
  store.dispatch(ag({ t: 'task', id: 'k1', phase: 'started', desc: 'a', type: 'local_agent', call: 'toolu_A' }));
  store.dispatch(ag({ t: 'task', id: 'k2', phase: 'started', desc: 'b', type: 'local_bash' })); // no call
  expect([...selectLiveCalls(store.getState())]).toEqual(['toolu_A']);
  store.dispatch(ag({ t: 'task', id: 'k1', phase: 'done' }));
  expect([...selectLiveCalls(store.getState())]).toEqual([]);
});
