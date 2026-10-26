import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { SERVER_RESTART_TIMEOUT_MS } from '@/controls/slice.ts';
import { Header } from './Header.tsx';
import { getToasts, resetToasts } from './toast.ts';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const SESSION: ServerEvent = { kind: 'session', id: 'abc12345', root: '/p/proj', title: null, model: null };

function mockFetch(supervised: boolean, restart: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return url === '/info' ? new Response(JSON.stringify({ supervised })) : restart();
  }));
  return calls;
}

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  let state!: (s: 'open' | 'closed') => void;
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, e: typeof ev, s: typeof state) => { ev = e; state = s; s('open'); return { send: (m: ClientMessage) => (sent.push(m), true), close() {} }; }) as never });
  render(<Provider store={store}><Header /></Provider>);
  return { sent, store, ev: (e: ServerEvent) => act(() => ev(e)), state: (s: 'open' | 'closed') => act(() => state(s)) };
}

beforeEach(() => { setLang('en'); resetToasts(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('hides the server item when the server is not supervised', async () => {
  mockFetch(false, () => new Response('', { status: 200 }));
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  expect(await screen.findByText('Restart the agent')).toBeInTheDocument();
  expect(screen.queryByText('Restart the server')).toBeNull();
});

it('a plain click on ↻ still restarts the agent', async () => {
  mockFetch(true, () => new Response(''));
  const { sent } = setup();
  await userEvent.click(screen.getByRole('button', { name: '↻ Agent' }));
  expect(sent).toEqual([{ type: 'restart' }]);
});

it('the server item POSTs /restart-server and shows restarting…; close, open, replay with the session ends it', async () => {
  const calls = mockFetch(true, () => new Response('', { status: 200 }));
  const { ev, state } = setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  const item = await screen.findByText('Restart the server');
  expect(item.closest('[role=menuitem]')).toHaveAttribute('title', 'picks up server code changes; the window reconnects by itself');
  await userEvent.click(item);
  await waitFor(() => expect(calls.find((c) => c.url === '/restart-server')?.init).toMatchObject({ method: 'POST' }));
  expect(document.getElementById('conn')).toHaveTextContent('restarting…');
  state('closed'); // the old socket goes first: must not end the phase
  expect(document.getElementById('conn')).not.toHaveTextContent('');
  state('open');
  expect(document.getElementById('restartBtn')).toBeDisabled();
  ev({ kind: 'replay', events: [SESSION] } as ServerEvent);
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(document.getElementById('restartBtn')).not.toBeDisabled();
});

it('a 409 answer toasts restartFail with the response text and releases the UI', async () => {
  mockFetch(true, () => new Response('agent is busy', { status: 409 }));
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  await userEvent.click(await screen.findByText('Restart the server'));
  await waitFor(() => expect(getToasts()).toHaveLength(1));
  expect(getToasts()[0]).toMatchObject({ title: 'Could not restart the server: ', msg: 'agent is busy' });
  expect(document.getElementById('conn')).toHaveTextContent('');
});

it('no reconnect within 30 s releases the UI and toasts', async () => {
  mockFetch(true, () => new Response('', { status: 200 }));
  setup();
  await userEvent.click(screen.getByRole('button', { name: 'Restart menu' }));
  const item = await screen.findByText('Restart the server');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(item);
  await waitFor(() => expect(document.getElementById('conn')).toHaveTextContent('restarting…'));
  await act(async () => { await vi.advanceTimersByTimeAsync(SERVER_RESTART_TIMEOUT_MS + 10); });
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(getToasts()).toHaveLength(1);
});
