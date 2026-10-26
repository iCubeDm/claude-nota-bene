import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { activate, openFile, selectTabs } from '@/tabs/slice.ts';
import { RecentFiles } from './RecentFiles.tsx';
import { RECENT_MAX, readRecent, recentModal } from './recent.ts';

let complete: string[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  complete = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(complete), { status: 200 })));
});
afterEach(() => { cleanup(); act(() => recentModal.close()); vi.unstubAllGlobals(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/p', title: null, model: null })));
  render(<Provider store={store}><RecentFiles /></Provider>);
  return store;
}
const items = () => [...document.querySelectorAll<HTMLElement>('[data-recent]')].map((b) => b.dataset.recent);
const ctrlE = () => fireEvent.keyDown(window, { key: 'e', code: 'KeyE', ctrlKey: true });

it('every activated file tab is recorded per root, newest first, once each, at most 50 (M6-13)', () => {
  const store = setup();
  act(() => {
    store.dispatch(openFile('a.ts'));
    store.dispatch(openFile('b.md'));
    store.dispatch(activate('file:a.ts'));
    store.dispatch(activate('chat')); // the chat is not a file
  });
  expect(readRecent('/p').map((f) => f.path)).toEqual(['a.ts', 'b.md']);
  act(() => { for (let i = 0; i < 60; i++) store.dispatch(openFile(`f${i}.ts`)); });
  expect(readRecent('/p')).toHaveLength(RECENT_MAX);
  expect(readRecent('/p')[0]!.path).toBe('f59.ts');
  expect(readRecent('/other')).toEqual([]);
});

it('Ctrl+E opens the list with the previous file selected; Enter flips back; Esc closes (M6-13)', async () => {
  const store = setup();
  act(() => { store.dispatch(openFile('src/a.ts')); store.dispatch(openFile('docs/b.md')); });
  ctrlE();
  await screen.findByRole('listbox', { name: 'Recent files' });
  expect(items()).toEqual(['docs/b.md', 'src/a.ts']);
  expect(screen.getByRole('option', { selected: true })).toHaveAttribute('data-recent', 'src/a.ts');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(selectTabs(store.getState()).active).toBe('file:src/a.ts');
  expect(screen.queryByRole('listbox')).toBeNull();
  ctrlE();
  await screen.findByRole('listbox');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
});

it('a query filters the recent files and adds project hits from /complete (files only, no duplicates); ↓ moves (M6-13)', async () => {
  const store = setup();
  act(() => { store.dispatch(openFile('src/app.ts')); store.dispatch(openFile('README.md')); });
  complete = ['src/app.ts', 'src/', 'src/apple.ts', 'web/app.css'];
  act(() => recentModal.open());
  const box = await screen.findByRole('textbox', { name: /Search recent files/ });
  fireEvent.change(box, { target: { value: 'app' } });
  expect(items()).toEqual(['src/app.ts']); // the recent match at once
  await waitFor(() => expect(items()).toEqual(['src/app.ts', 'src/apple.ts', 'web/app.css']));
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/complete?q=app', expect.anything());
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(selectTabs(store.getState()).active).toBe('file:web/app.css');
});

it('a file of another source reopens in that source (M6-13)', async () => {
  const store = setup();
  act(() => { store.dispatch(openFile({ path: 'x.ts', src: 'ref:feature', ref: 'feature' })); store.dispatch(activate('chat')); });
  act(() => recentModal.open());
  await screen.findByRole('listbox');
  expect(screen.getByText('@ feature', { exact: false })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(selectTabs(store.getState()).active).toBe('file:ref:feature:x.ts');
});
