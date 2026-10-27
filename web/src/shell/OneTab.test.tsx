import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, takeOver } from '@/store/store.ts';
import type { SocketState } from '@/net/socket.ts';
import { FAV, favState } from './Favicon.ts';
import { OneTab } from './OneTab.tsx';

afterEach(cleanup);

function setup() {
  let ev!: (e: ServerEvent) => void;
  let state!: (s: SocketState) => void;
  const sent: ClientMessage[] = [];
  let reconnects = 0;
  const store = makeStore({
    url: 'ws://x',
    connect: (_u, onEvent, onState) => {
      ev = onEvent;
      state = onState;
      return { send: (m) => { sent.push(m); return true; }, close() {}, reconnect: () => { reconnects++; } };
    },
  });
  render(<Provider store={store}><OneTab /></Provider>);
  return {
    store, sent,
    reconnects: () => reconnects,
    ev: (e: ServerEvent) => act(() => ev(e)),
    state: (s: SocketState) => act(() => state(s)),
  };
}

it('shows nothing while this tab owns the window', () => {
  setLang('en');
  const h = setup();
  h.state('open');
  h.ev({ kind: 'hello', protocol: 5 });
  expect(screen.queryByTestId('onetab')).toBeNull();
});

it('occupied: the overlay says the window is open elsewhere; the button sends takeover on the open socket', () => {
  setLang('en');
  const h = setup();
  h.state('open');
  h.ev({ kind: 'occupied' });
  expect(screen.getByTestId('onetab')).toHaveAttribute('data-state', 'occupied');
  expect(screen.getByText('The window is already open in another tab')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Work here' }));
  expect(h.sent).toEqual([{ type: 'takeover' }]);
  expect(h.reconnects()).toBe(0);
  expect(screen.getByTestId('onetab')).toBeInTheDocument(); // until the server answers
  h.state('open'); // the socket layer reports the attach when the replay arrives, just before handing it on
  h.ev({ kind: 'replay', events: [] }); // the takeover went through: only the owner gets a replay
  expect(screen.queryByTestId('onetab')).toBeNull();
});

it('taken: the overlay in Russian; the button reconnects and answers occupied with takeover without showing the occupied screen', () => {
  setLang('ru');
  const h = setup();
  h.state('open');
  h.ev({ kind: 'taken-over' });
  h.state('taken'); // the close with 4001 follows the frame
  expect(screen.getByTestId('onetab')).toHaveAttribute('data-state', 'taken');
  expect(screen.getByText('Открыто в другой вкладке')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Работать здесь' }));
  expect(h.reconnects()).toBe(1);
  // the overlay stays (inert) until the attach: the stale app is never clickable meanwhile
  expect(screen.getByTestId('onetab')).toHaveAttribute('data-state', 'taken');
  h.ev({ kind: 'occupied' });
  expect(h.sent).toEqual([{ type: 'takeover' }]);
  expect(screen.getByTestId('onetab')).toHaveAttribute('data-state', 'taken'); // no flash of the occupied screen
  h.state('open');
  h.ev({ kind: 'replay', events: [] });
  expect(screen.queryByTestId('onetab')).toBeNull();
  setLang('en');
});

it('an occupied or taken tab is idle grey in the favicon, not the red of a dropped connection', () => {
  const h = setup();
  h.state('open');
  h.ev({ kind: 'occupied' });
  expect(favState(h.store.getState(), null)).toBe('idle');
  expect(FAV.idle).toBeTruthy();
  h.state('taken');
  expect(favState(h.store.getState(), null)).toBe('idle');
  h.state('closed');
  expect(favState(h.store.getState(), null)).toBe('error');
});

it('the page sends its tab id in the url; a resync and a send wait for the attach', async () => {
  const { addComment } = await import('@/comments/slice.ts');
  const { sendMessage } = await import('@/store/store.ts');
  let ev!: (e: ServerEvent) => void;
  let state!: (s: SocketState) => void;
  let url = '';
  const sent: ClientMessage[] = [];
  let attached = false; // what socket.ts does: nothing goes out before the replay (but `takeover`)
  const store = makeStore({
    url: 'ws://x/ws',
    connect: (u, onEvent, onState) => {
      url = typeof u === 'function' ? u() : u; ev = onEvent; state = onState;
      return { send: (m) => { if (!attached && m.type !== 'takeover') return false; sent.push(m); return true; }, close() {} };
    },
  });
  expect(url).toMatch(/^ws:\/\/x\/ws\?tab=[0-9a-f-]{36}$/);
  // a comment written while offline, and a send typed during the grace: neither goes out
  act(() => { store.dispatch(addComment({ source: { kind: 'message', id: 'm' }, quote: 'q', text: 't', anchor: { start: 0, end: 1 } } as never) as never); });
  expect(store.getState().comments.unsynced).toBe(true);
  expect(store.dispatch(sendMessage('typed in the grace', false))).toBe(false);
  expect(sent).toEqual([]);
  // attached: the replay arrives, the socket layer reports open, the offline comment is re-sent, and a send now goes
  attached = true;
  act(() => { state('open'); ev({ kind: 'replay', events: [] }); });
  expect(sent.map((m) => m.type)).toEqual(['comments']);
  expect(store.dispatch(sendMessage('after attach', false))).toBe(true);
  expect(sent.map((m) => m.type)).toEqual(['comments', 'send']);
});

it('a takeover whose send did not go out is kept: the next occupied is answered with takeover', () => {
  setLang('en');
  let ev!: (e: ServerEvent) => void;
  let state!: (s: SocketState) => void;
  let up = false;
  const sent: ClientMessage[] = [];
  const store = makeStore({
    url: 'ws://x',
    connect: (_u, onEvent, onState) => {
      ev = onEvent; state = onState;
      return { send: (m) => { if (!up) return false; sent.push(m); return true; }, close() {}, reconnect: () => {} };
    },
  });
  act(() => { up = true; state('open'); ev({ kind: 'occupied' }); });
  up = false; // the socket dropped between the screen and the click
  act(() => void store.dispatch(takeOver()));
  expect(sent).toEqual([]);
  up = true;
  act(() => ev({ kind: 'occupied' }));
  expect(sent).toEqual([{ type: 'takeover' }]);
});

it('an occupied or taken page reconnects passive; a fresh or dropped one does not (I1)', () => {
  let urlOf!: () => string;
  let state!: (s: SocketState) => void;
  let ev!: (e: ServerEvent) => void;
  const store = makeStore({
    url: 'ws://x/ws',
    connect: (u, onEvent, onState) => {
      urlOf = typeof u === 'function' ? u : () => u;
      ev = onEvent; state = onState;
      return { send: () => true, close() {}, reconnect() {} };
    },
  });
  expect(urlOf()).not.toContain('passive');
  act(() => { state('open'); ev({ kind: 'replay', events: [] }); });
  expect(urlOf()).not.toContain('passive');
  act(() => state('closed'));
  expect(urlOf()).not.toContain('passive'); // the owner whose connection dropped
  act(() => ev({ kind: 'occupied' }));
  expect(store.getState().conn.state).toBe('occupied');
  expect(urlOf()).toMatch(/&passive=1$/);
  act(() => ev({ kind: 'taken-over' }));
  act(() => state('taken'));
  expect(urlOf()).toMatch(/&passive=1$/);
  expect(urlOf()).toMatch(/^ws:\/\/x\/ws\?tab=[0-9a-f-]{36}&passive=1$/);
});

it('a takeover attach adopts the server comments: the offline edits of the old tab are dropped, not re-sent (Minor 6)', async () => {
  const { addComment } = await import('@/comments/slice.ts');
  let ev!: (e: ServerEvent) => void;
  let state!: (s: SocketState) => void;
  let up = true;
  const sent: ClientMessage[] = [];
  const store = makeStore({
    url: 'ws://x/ws',
    connect: (_u, onEvent, onState) => {
      ev = onEvent; state = onState;
      return { send: (m) => { if (!up && m.type !== 'takeover') return false; sent.push(m); return true; }, close() {}, reconnect() {} };
    },
  });
  act(() => { state('open'); ev({ kind: 'replay', events: [] }); });
  act(() => { up = false; state('closed'); });
  act(() => { store.dispatch(addComment({ source: { kind: 'message', id: 'm' }, quote: 'q', text: 'offline', anchor: { start: 0, end: 1 } } as never) as never); });
  expect(store.getState().comments.unsynced).toBe(true);
  up = true; // reconnected, but another tab owns the window now
  act(() => ev({ kind: 'occupied' }));
  sent.length = 0;
  act(() => void store.dispatch(takeOver()));
  expect(sent).toEqual([{ type: 'takeover' }]);
  const theirs = [{ id: 'c9', anchor: {}, text: 'from the other tab', status: 'pending', createdAt: 1 }];
  act(() => { state('open'); ev({ kind: 'replay', events: [] }); ev({ kind: 'comments', items: theirs as never }); });
  expect(sent.map((m) => m.type)).toEqual(['takeover']); // no `comments` push
  expect(store.getState().comments.items).toEqual(theirs);
});
