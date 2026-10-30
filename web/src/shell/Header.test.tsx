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

it('the globe opens the language list; a pick re-renders the header', () => {
  setLang('ru');
  setup();
  const btn = screen.getByRole('button', { name: 'Язык интерфейса' });
  expect(screen.getByText('подключение…')).toBeInTheDocument();
  fireEvent.keyDown(btn, { key: 'Enter' });
  expect(screen.getByRole('menuitem', { name: 'Русский' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'English' }));
  expect(screen.getByRole('button', { name: 'Interface language' })).toBeInTheDocument();
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
  ev({ kind: 'session', id: null, root: '/Users/me/proj', title: null, model: null });
  expect(document.getElementById('root-path')).toHaveTextContent('/Users/me/proj');
  expect(document.getElementById('session')).toHaveTextContent('');
  ev({ kind: 'session', id: '5f0c2a9e-7d41-4c4b', root: '/Users/me/proj', title: null, model: null });
  expect(document.getElementById('session')).toHaveTextContent(/^5f0c2a9e$/);
});

it('the project name, not the app name, titles the header and the browser tab', () => {
  const { ev } = setup();
  expect(document.getElementById('proj')).toHaveTextContent('Nota Bene');
  ev({ kind: 'session', id: null, root: '/Users/me/my-project', title: null, model: null });
  expect(document.getElementById('proj')).toHaveTextContent(/^my-project$/);
  expect(document.title).toBe('my-project · Nota Bene');
});

it('document title: session title first when there is one; header shows the model pill and id8, or id8 alone', () => {
  const { ev } = setup();
  ev({ kind: 'session', id: '5f0c2a9e-7d41', root: '/p/proj', title: 'Fix login', model: 'opus' });
  expect(document.title).toBe('Fix login · proj · Nota Bene');
  expect(document.getElementById('session')).toHaveTextContent(/^5f0c2a9e$/);
  expect(screen.getByRole('button', { name: /Model and effort|Модель и усилие/ })).toHaveTextContent('opus'); // no list yet: the name as reported
  ev({ kind: 'session', id: '5f0c2a9e-7d41', root: '/p/proj', title: null, model: null });
  expect(screen.queryByRole('button', { name: /Model and effort|Модель и усилие/ })).toBeNull();
  expect(document.title).toBe('proj · Nota Bene');
  expect(document.getElementById('session')).toHaveTextContent(/^5f0c2a9e$/);
});
