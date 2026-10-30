import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import type { SocketState } from '@/net/socket.ts';
import { LoginRequired } from './LoginRequired.tsx';

afterEach(cleanup);

function setup() {
  let state!: (s: SocketState) => void;
  const store = makeStore({ url: 'ws://x', connect: (_u, _e, onState) => { state = onState; return { send: () => true, close() {}, reconnect() {} }; } });
  render(<Provider store={store}><LoginRequired /></Provider>);
  return (s: SocketState) => act(() => state(s));
}

it('shows nothing while connected or merely reconnecting', () => {
  setLang('en');
  const state = setup();
  state('open');
  state('closed');
  expect(screen.queryByTestId('login-required')).toBeNull();
});

it('a refused login shows how to reopen the window, in English and in Russian, with no button that retries', () => {
  setLang('en');
  const state = setup();
  state('unauthorized');
  const box = screen.getByTestId('login-required');
  expect(box.textContent).toMatch(/nota-bene|\/nb/);
  expect(box.textContent).toMatch(/not logged in|log in/i);
  expect(screen.queryByRole('button')).toBeNull();
  cleanup();
  setLang('ru');
  const state2 = setup();
  state2('unauthorized');
  expect(screen.getByTestId('login-required').textContent).toMatch(/\/nb/);
  expect(screen.getByTestId('login-required').textContent).toMatch(/[а-я]/i);
  setLang('en');
});
