import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { activate, openFile, selectTabs } from '@/tabs/slice.ts';
import { RecentFiles } from './RecentFiles.tsx';
import { RECENT_DWELL_MS, RECENT_MAX, readRecent, recentModal } from './recent.ts';

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
// a tab is recorded once it stays active RECENT_DWELL_MS
const dwell = () => act(() => new Promise<void>((r) => setTimeout(r, RECENT_DWELL_MS + 30)));
const items = () => [...document.querySelectorAll<HTMLElement>('[data-recent]')].map((b) => b.dataset.recent);
// Alt+E itself is the keymap's (shell/keymap.test.tsx); here the modal opens as the keymap opens it
const ctrlE = () => act(() => recentModal.open());

it('a file tab that stays active is recorded, newest first, once each, at most 50 (M6-13)', async () => {
  const store = setup();
  act(() => void store.dispatch(openFile('b.md')));
  await dwell();
  act(() => void store.dispatch(openFile('a.ts')));
  await dwell();
  act(() => void store.dispatch(activate('chat'))); // the chat is not a file
  await dwell();
  expect(readRecent('/p').map((f) => f.path)).toEqual(['a.ts', 'b.md']);
  // stepping through tabs quickly records none of the passed ones, only where it stops
  act(() => { for (let i = 0; i < 60; i++) store.dispatch(openFile(`f${i}.ts`)); });
  await dwell();
  expect(readRecent('/p').map((f) => f.path)).toEqual(['f59.ts', 'a.ts', 'b.md']);
  // at most RECENT_MAX
  for (let i = 0; i < 55; i++) localStorage.setItem('recent:/p', JSON.stringify([...readRecent('/p'), { path: `x${i}.ts` }]));
  act(() => void store.dispatch(activate('file:f3.ts')));
  await dwell();
  expect(readRecent('/p')).toHaveLength(RECENT_MAX);
  expect(readRecent('/p')[0]!.path).toBe('f3.ts');
});

it('opening shows the list with the previous file selected; Enter flips back; Esc closes (M6-13)', async () => {
  const store = setup();
  act(() => void store.dispatch(openFile('src/a.ts')));
  await dwell();
  act(() => void store.dispatch(openFile('docs/b.md')));
  await dwell();
  ctrlE();
  await screen.findByRole('listbox', { name: 'Recent files' });
  expect(items()).toEqual(['docs/b.md', 'src/a.ts']);
  expect(screen.getByRole('option', { selected: true })).toHaveAttribute('data-recent', 'src/a.ts');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(selectTabs(store.getState()).active).toBe('file:src/a.ts');
  expect(screen.queryByRole('listbox')).toBeNull();
  ctrlE();
  await screen.findByRole('listbox');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
});

it('a query filters the recent files and adds project hits from /complete (files only, no duplicates); ↓ moves (M6-13)', async () => {
  const store = setup();
  act(() => void store.dispatch(openFile('src/app.ts')));
  await dwell();
  act(() => void store.dispatch(openFile('README.md')));
  await dwell();
  complete = ['src/app.ts', 'src/', 'src/apple.ts', 'web/app.css'];
  act(() => recentModal.open());
  const box = await screen.findByRole('combobox', { name: /Search recent files/ });
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
  act(() => void store.dispatch(openFile({ path: 'x.ts', src: 'ref:feature', ref: 'feature' })));
  await dwell();
  act(() => void store.dispatch(activate('chat')));
  act(() => recentModal.open());
  await screen.findByRole('listbox');
  expect(screen.getByText('@ feature', { exact: false })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(selectTabs(store.getState()).active).toBe('file:ref:feature:x.ts');
  await dwell(); // its recording timer fires here, not in the next test
});

it('after a switch to another folder the list is that folder\'s; the first folder keeps its own (M6-13 review)', async () => {
  const store = setup();
  act(() => void store.dispatch(openFile('a.ts')));
  await dwell();
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 's2', root: '/q', title: null, model: null })));
  act(() => void store.dispatch(openFile('q.ts')));
  await dwell();
  expect(readRecent('/q').map((f) => f.path)).toEqual(['q.ts']);
  expect(readRecent('/p').map((f) => f.path)).toEqual(['a.ts']);
  act(() => recentModal.open());
  await screen.findByRole('listbox');
  expect(items()).toEqual(['q.ts']);
});
