import { act, cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Header } from './Header.tsx';

let answer: unknown;
let calls: number;
beforeEach(() => {
  vi.useFakeTimers();
  setLang('en');
  answer = { branch: 'main', detached: false, dirty: false };
  calls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/git-status') { calls++; return new Response(JSON.stringify(answer)); }
    return new Response('nope', { status: 404 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setLang('ru'); });

const session = (root: string): ServerEvent => ({ kind: 'session', id: null, root, title: null, model: null });
const result: ServerEvent = { kind: 'sdk', ts: 1, m: { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, user_message_uuids: ['u1'] } } as unknown as ServerEvent;

async function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><Header /></Provider>);
  const ev = (e: ServerEvent) => act(async () => { store.dispatch(serverEvent(e)); await vi.advanceTimersByTimeAsync(0); });
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  return { ev, wait, el: () => document.getElementById('git-branch') };
}

it('shows (branch ✔) when clean, with a tooltip; nothing before a root is known', async () => {
  const { ev, el } = await setup();
  expect(el()).toBeNull();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('(main ✔)');
  expect(el()).toHaveAttribute('title', 'git branch · clean');
  expect(el()!.querySelector('[data-dirty]')).toBeNull();
});

it('shows ✗ and the uncommitted tooltip when dirty, in ru as well', async () => {
  answer = { branch: 'feature/x', detached: false, dirty: true };
  setLang('ru');
  const { ev, el } = await setup();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('(feature/x ✗)');
  expect(el()).toHaveAttribute('title', 'ветка git · есть незакоммиченные изменения или новые файлы');
  expect(el()!.querySelector('[data-dirty]')).not.toBeNull();
});

it('detached HEAD shows (detached ✔/✗); a non-repo shows nothing', async () => {
  answer = { branch: null, detached: true, dirty: true };
  const { ev, el } = await setup();
  await ev(session('/p/proj'));
  expect(el()).toHaveTextContent('(detached ✗)');
  answer = null;
  await ev(session('/p/other'));
  expect(el()).toBeNull();
});

it('refetches after a live turn, throttled to one request per 3 s (the late one still lands)', async () => {
  const { ev, wait, el } = await setup();
  await ev(session('/p/proj'));
  expect(calls).toBe(1);
  answer = { branch: 'main', detached: false, dirty: true };
  await ev(result); // within 3 s of the first: deferred, not dropped
  expect(calls).toBe(1);
  expect(el()).toHaveTextContent('(main ✔)');
  await wait(3000);
  expect(calls).toBe(2);
  expect(el()).toHaveTextContent('(main ✗)');
});

it('refetches on window focus, and on a root change', async () => {
  const { ev, wait } = await setup();
  await ev(session('/p/proj'));
  await wait(3000);
  act(() => { window.dispatchEvent(new Event('focus')); });
  await wait(0);
  expect(calls).toBe(2);
  await wait(3000);
  await ev(session('/p/other'));
  expect(calls).toBe(3);
});
