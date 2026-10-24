import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Header } from './Header.tsx';

afterEach(cleanup);

function setup() {
  let state!: (s: 'open' | 'closed') => void;
  const store = makeStore({ url: 'ws://x', connect: (_u, _e, s) => { state = s; return { send: () => true, close() {} }; } });
  render(
    <Provider store={store}>
      <Header />
    </Provider>,
  );
  return {
    state: (s: 'open' | 'closed') => act(() => state(s)),
    ev: (e: ServerEvent) => act(() => { store.dispatch(serverEvent(e)); }),
  };
}

it('the toggle shows the other language and re-renders the header on click', () => {
  setLang('ru');
  setup();
  const btn = screen.getByRole('button', { name: 'EN' });
  expect(btn).toHaveAttribute('title', 'Язык интерфейса: English');
  expect(screen.getByText('подключение…')).toBeInTheDocument();
  fireEvent.click(btn);
  expect(screen.getByRole('button', { name: 'RU' })).toBeInTheDocument();
  expect(screen.getByText('connecting…')).toBeInTheDocument();
  setLang('ru');
});

it('connection label: connecting before the first open, nothing while open, offline after a drop', () => {
  setLang('en');
  const { state } = setup();
  expect(document.getElementById('conn')).toHaveTextContent('connecting…');
  state('open');
  expect(document.getElementById('conn')).toHaveTextContent('');
  state('closed');
  expect(document.getElementById('conn')).toHaveTextContent('no connection to the server…');
  state('open');
  expect(document.getElementById('conn')).toHaveTextContent('');
});

it('path and short session id come from the session event', () => {
  const { ev } = setup();
  expect(document.getElementById('root-path')).toHaveTextContent('');
  ev({ kind: 'session', id: null, root: '/Users/me/proj' });
  expect(document.getElementById('root-path')).toHaveTextContent('/Users/me/proj');
  expect(document.getElementById('session')).toHaveTextContent('');
  ev({ kind: 'session', id: '5f0c2a9e-7d41-4c4b', root: '/Users/me/proj' });
  expect(document.getElementById('session')).toHaveTextContent(/^5f0c2a9e$/);
});
