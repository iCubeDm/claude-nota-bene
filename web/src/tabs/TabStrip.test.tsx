import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
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

it('Copy path writes the project-relative path; Reveal is not in the menu (it is in the tree header, M6-10)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  setup(['src/a/x.ts']);
  fireEvent.click(within(menu(tab('x.ts'))).getByRole('menuitem', { name: 'Copy path' }));
  expect(writeText).toHaveBeenCalledWith('src/a/x.ts');
  expect(within(menu(tab('x.ts'))).queryByRole('menuitem', { name: /reveal/i })).toBeNull();
});

it('labels are basenames with the full path in title; aria-selected follows the active tab', () => {
  setup(['src/a/x.ts']);
  expect(tab('x.ts').querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('ts'); // M6-11
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

it('the chat tab shows the session title and tooltip; without one, Chat and the chatTip', () => {
  const store = setup();
  const chat = screen.getByRole('tab', { name: /Chat/ });
  expect(chat).toHaveAttribute('title', 'Chat with the agent');
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 'abcdefgh', root: '/p', title: 'Fix login', model: null })));
  const titled = screen.getByRole('tab', { name: /Fix login/ });
  expect(titled).toHaveAttribute('title', 'Fix login');
});

// ---- M6-12: overflow
const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 28, width, height: 28, x: left, y: 0, toJSON() {} }) as DOMRect;

it('▾ lists the hidden tabs first, then all; the filter matches paths; ↓ Enter opens; the strip has no scrollbar (M6-12)', async () => {
  const s = setup(['src/a.ts', 'src/b.ts', 'docs/c.md']);
  const strip = screen.getByRole('tablist');
  expect(strip.className).toContain('nb-no-scrollbar');
  // layout: the strip shows 0..300 px; c.md sits past its right edge
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 300));
  const at: Record<string, number> = { chat: 0, 'file:src/a.ts': 100, 'file:src/b.ts': 200, 'file:docs/c.md': 320 };
  for (const el of strip.querySelectorAll<HTMLElement>('[data-tab]')) vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(at[el.dataset.tab!]!, 90));
  fireEvent.click(screen.getByRole('button', { name: 'All tabs' }));
  const list = await screen.findByRole('listbox', { name: 'All tabs' });
  const items = () => [...list.querySelectorAll<HTMLElement>('[data-tab-item]')].map((b) => b.dataset.tabItem);
  expect(within(list).getByText('Hidden')).toBeInTheDocument();
  expect(items()).toEqual(['file:docs/c.md', 'chat', 'file:src/a.ts', 'file:src/b.ts', 'file:docs/c.md']);
  const box = screen.getByRole('combobox', { name: 'Find a tab…' });
  fireEvent.change(box, { target: { value: 'src/' } });
  expect(items()).toEqual(['file:src/a.ts', 'file:src/b.ts']);
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(selectTabs(s.getState()).active).toBe('file:src/b.ts');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('the wheel scrolls the strip sideways (M6-12)', () => {
  setup(['a.ts']);
  const strip = screen.getByRole('tablist');
  fireEvent.wheel(strip, { deltaY: 120, deltaX: 0 });
  expect(strip.scrollLeft).toBe(120);
});

it('the active tab is scrolled into view when it changes (M6-12)', () => {
  const seen: string[] = [];
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) { seen.push((this as HTMLElement).dataset.tab ?? ''); };
  try {
    const s = setup(['a.ts', 'b.ts']);
    seen.length = 0;
    act(() => void s.dispatch(openFile('a.ts')));
    expect(seen).toContain('file:a.ts');
  } finally {
    Element.prototype.scrollIntoView = orig;
  }
});
