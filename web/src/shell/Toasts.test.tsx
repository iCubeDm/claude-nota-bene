import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Header } from './Header.tsx';
import { Toasts } from './Toasts.tsx';
import { resetToasts, toast } from './toast.ts';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => { vi.useFakeTimers(); setLang('en'); resetToasts(); });
afterEach(() => { cleanup(); resetToasts(); vi.useRealTimers(); });

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  const store = makeStore({
    url: 'ws://x',
    connect: ((_u: string, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
      ev = onEvent; onState('open');
      return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
    }) as never,
  });
  render(<Provider store={store}><Header /><Toasts /></Provider>);
  return { sent, store, ev: (e: ServerEvent) => act(() => ev(e)) };
}
const err = (where: string, message: string): ServerEvent => ({ kind: 'server-error', where, message });
const items = () => screen.queryAllByTestId('toast');

it('a server-error becomes a toast; two identical ones make one toast with x2', () => {
  const { ev } = setup();
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  ev(err('comments', 'EACCES'));
  expect(items()).toHaveLength(1);
  expect(items()[0]).toHaveTextContent('Server error · comments');
  expect(items()[0]).toHaveTextContent('EACCES');
  expect(items()[0]).not.toHaveTextContent('×');
  ev(err('comments', 'EACCES'));
  expect(items()).toHaveLength(1);
  expect(items()[0]).toHaveTextContent('Server error · comments ×2');
  ev(err('comments', 'other'));
  expect(items()).toHaveLength(2);
});

it('closes after 15 s; a repeat restarts the timer', () => {
  setup();
  act(() => { toast('T', 'm'); });
  act(() => { vi.advanceTimersByTime(10_000); });
  act(() => { toast('T', 'm'); });
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(items()).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(items()).toHaveLength(0);
});

it('hover pauses the timer, leaving restarts the full 15 s', () => {
  setup();
  act(() => { toast('T', 'm'); });
  fireEvent.mouseEnter(items()[0]);
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(items()).toHaveLength(1);
  fireEvent.mouseLeave(items()[0]);
  act(() => { vi.advanceTimersByTime(14_999); });
  expect(items()).toHaveLength(1);
  act(() => { vi.advanceTimersByTime(1); });
  expect(items()).toHaveLength(0);
});

it('the close button (with an aria-label) closes it', () => {
  setup();
  act(() => { toast('T', 'm'); toast('U', 'n'); });
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
  expect(items()).toHaveLength(1);
  expect(items()[0]).toHaveTextContent('U');
});

it('at most 5 toasts: the oldest drops', () => {
  setup();
  act(() => { for (let i = 1; i <= 6; i++) toast('T' + i, 'm'); });
  expect(items()).toHaveLength(5);
  expect(items()[0]).toHaveTextContent('T2');
  expect(items()[4]).toHaveTextContent('T6');
});

it('a busy refusal makes no toast (it is broadcast to every window)', () => {
  const { ev } = setup();
  ev(err('busy', 'the session is switching; the message was not sent'));
  expect(items()).toHaveLength(0);
});

it('a server error no longer lands in the feed', () => {
  const { ev, store } = setup();
  ev(err('ws', 'boom'));
  expect(store.getState().feed.items).toEqual([]);
});

it('restart sends once, shows restarting… until the next session, and is disabled meanwhile', () => {
  const { sent, ev } = setup();
  const btn = screen.getByRole('button', { name: /Agent/ });
  expect(btn).toHaveAttribute('title', 'Restart the agent and continue the same session');
  fireEvent.click(btn);
  expect(sent.filter((m) => m.type === 'restart')).toHaveLength(1);
  expect(document.getElementById('conn')).toHaveTextContent('restarting…');
  expect(btn).toBeDisabled();
  ev({ kind: 'session', id: 'a', root: '/r', title: null, model: null }); // before the reset: the old session's
  expect(document.getElementById('conn')).toHaveTextContent('restarting…');
  ev({ kind: 'replay', events: [] } as never);
  ev({ kind: 'session', id: 'a', root: '/r', title: null, model: null });
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(btn).toBeEnabled();
});

it('restart stays enabled while the agent is busy', () => {
  const { ev, sent } = setup();
  ev({ kind: 'sdk', m: { type: 'system', subtype: 'init' } } as never);
  ev({ kind: 'user', id: 'u', text: 'hi', ts: 1 } as never);
  fireEvent.click(screen.getByRole('button', { name: /Agent/ }));
  expect(sent.some((m) => m.type === 'restart')).toBe(true);
});

it('a refused restart (server-error where switch) clears restarting and toasts', () => {
  const { ev } = setup();
  fireEvent.click(screen.getByRole('button', { name: /Agent/ }));
  ev(err('switch', 'a switch is in progress'));
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(items()[0]).toHaveTextContent('Server error · switch');
});
