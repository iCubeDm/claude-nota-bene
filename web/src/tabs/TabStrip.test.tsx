import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { App } from '@/App.tsx';
import { openFile, selectTabs } from './slice.ts';

beforeEach(() => { localStorage.clear(); setLang('en'); });
afterEach(cleanup);

function setup(files: string[] = []) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  for (const f of files) store.dispatch(openFile(f));
  render(<Provider store={store}><App /></Provider>);
  return store;
}
const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
const ids = (s: ReturnType<typeof setup>) => selectTabs(s.getState()).open.map((t) => t.id);
const menu = (el: HTMLElement) => { fireEvent.contextMenu(el); return screen.getByRole('menu'); };

it('the chat context menu has no Close, only Close others and Close all', () => {
  setup(['a/x.ts']);
  const m = within(menu(tab('Chat')));
  expect(m.queryByRole('menuitem', { name: 'Close' })).toBeNull();
  expect(m.getByRole('menuitem', { name: 'Close others' })).toBeInTheDocument();
  expect(m.getByRole('menuitem', { name: 'Close all' })).toBeInTheDocument();
  expect(m.queryByRole('menuitem', { name: 'Copy path' })).toBeNull();
});

it('Close others keeps the chat and that tab', () => {
  const s = setup(['a.ts', 'b.ts', 'c.ts']);
  fireEvent.click(within(menu(tab('b.ts'))).getByRole('menuitem', { name: 'Close others' }));
  expect(ids(s)).toEqual(['chat', 'file:b.ts']);
});

it('middle click closes a tab, but not the chat', () => {
  const s = setup(['a.ts']);
  fireEvent(tab('Chat'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(ids(s)).toEqual(['chat', 'file:a.ts']);
  fireEvent(tab('a.ts'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(ids(s)).toEqual(['chat']);
});

it('the × button closes and has an accessible name', () => {
  const s = setup(['a.ts']);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(ids(s)).toEqual(['chat']);
});

it('Copy path writes the project-relative path; Reveal raises tree/reveal', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const s = setup(['src/a/x.ts']);
  fireEvent.click(within(menu(tab('x.ts'))).getByRole('menuitem', { name: 'Copy path' }));
  expect(writeText).toHaveBeenCalledWith('src/a/x.ts');
  fireEvent.click(within(menu(tab('x.ts'))).getByRole('menuitem', { name: 'Reveal in tree' }));
  expect(s.getState().tree.reveal).toBe('src/a/x.ts');
});

it('labels are basenames with the full path in title; aria-selected follows the active tab', () => {
  setup(['src/a/x.ts']);
  expect(tab('x.ts')).toHaveAttribute('title', 'src/a/x.ts');
  expect(tab('x.ts')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Chat')).toHaveAttribute('aria-selected', 'false');
});

it('the chat pane is the same element across tab switches, only hidden', () => {
  const s = setup();
  const pane = document.querySelector('[data-chat-pane]') as HTMLElement;
  expect(pane).toHaveAttribute('data-pane', 'chat');
  pane.scrollTop = 120;
  act(() => { s.dispatch(openFile('a.ts')); });
  expect(document.querySelector('[data-chat-pane]')).toBe(pane);
  expect(pane).toHaveAttribute('hidden');
  expect(document.querySelector('[data-pane="file:a.ts"]')).not.toHaveAttribute('hidden');
  fireEvent.click(tab('Chat'));
  expect(document.querySelector('[data-chat-pane]')).toBe(pane);
  expect(pane).not.toHaveAttribute('hidden');
  expect(pane.scrollTop).toBe(120);
  expect(document.querySelector('[data-pane="file:a.ts"]')).toHaveAttribute('hidden');
});
