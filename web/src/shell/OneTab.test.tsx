import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
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
  expect(screen.queryByTestId('onetab')).toBeNull();
  h.state('open');
  h.ev({ kind: 'occupied' });
  expect(h.sent).toEqual([{ type: 'takeover' }]);
  expect(screen.queryByTestId('onetab')).toBeNull(); // no flash of the occupied screen
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

it('the page sends its tab id in the url; a resync and a send wait for the attach, an occupied socket never resyncs', async () => {
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
      url = u; ev = onEvent; state = onState;
      return { send: (m) => { if (!attached && m.type !== 'takeover') return false; sent.push(m); return true; }, close() {} };
    },
  });
  expect(url).toMatch(/^ws:\/\/x\/ws\?tab=[0-9a-f-]{36}$/);
  // a comment written while offline, and a send typed during the grace: neither goes out
  act(() => { store.dispatch(addComment({ source: { kind: 'message', id: 'm' }, quote: 'q', text: 't', anchor: { start: 0, end: 1 } } as never) as never); });
  expect(store.getState().comments.unsynced).toBe(true);
  expect(store.dispatch(sendMessage('typed in the grace', false))).toBe(false);
  expect(sent).toEqual([]);
  // occupied: still nothing
  act(() => ev({ kind: 'occupied' }));
  expect(sent).toEqual([]);
  // attached: the replay arrives, the socket layer reports open, the offline comment is re-sent, and a send now goes
  attached = true;
  act(() => { state('open'); ev({ kind: 'replay', events: [] }); });
  expect(sent.map((m) => m.type)).toEqual(['comments']);
  expect(store.dispatch(sendMessage('after attach', false))).toBe(true);
  expect(sent.map((m) => m.type)).toEqual(['comments', 'send']);
});
