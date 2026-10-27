import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { App } from '@/App.tsx';
import { recentModal } from '@/files/recent.ts';
import { openFile, selectTabs } from '@/tabs/slice.ts';
import { BINDINGS, keysLabel } from './keymap.ts';

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});
afterEach(() => { cleanup(); act(() => recentModal.close()); vi.unstubAllGlobals(); });

function setup(files: string[] = ['a.ts', 'b.ts', 'c.ts']) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/p', title: null, model: null })));
  for (const f of files) store.dispatch(openFile(f));
  render(<Provider store={store}><App /></Provider>);
  return store;
}
// jsdom is not a Mac: the mod key is Ctrl
const key = (code: string, mods: { alt?: boolean; shift?: boolean; mod?: boolean } = {}, target: Element | Document = document.body) =>
  fireEvent.keyDown(target, { code, key: code, altKey: !!mods.alt, shiftKey: !!mods.shift, ctrlKey: !!mods.mod, bubbles: true });
const active = (s: ReturnType<typeof setup>) => selectTabs(s.getState()).active;
const ids = (s: ReturnType<typeof setup>) => selectTabs(s.getState()).open.map((t) => t.id);

it('Alt+W closes the active tab (never the chat); Alt+Shift+T reopens the last closed one', () => {
  const s = setup();
  key('KeyW', { alt: true });
  expect(ids(s)).toEqual(['chat', 'file:a.ts', 'file:b.ts']);
  key('KeyW', { alt: true });
  key('KeyT', { alt: true, shift: true });
  expect(active(s)).toBe('file:b.ts');
  key('KeyT', { alt: true, shift: true });
  expect(ids(s)).toEqual(['chat', 'file:a.ts', 'file:b.ts', 'file:c.ts']);
  act(() => void s.dispatch({ type: 'tabs/activate', payload: 'chat' }));
  key('KeyW', { alt: true });
  expect(ids(s)).toHaveLength(4);
});

it('Alt+←/→ step through the tabs and wrap; Alt+1…9 pick a tab, 9 is the last', () => {
  const s = setup();
  key('ArrowRight', { alt: true });
  expect(active(s)).toBe('chat');
  key('ArrowLeft', { alt: true });
  expect(active(s)).toBe('file:c.ts');
  key('Digit2', { alt: true });
  expect(active(s)).toBe('file:a.ts');
  key('Digit1', { alt: true });
  expect(active(s)).toBe('chat');
  key('Digit9', { alt: true });
  expect(active(s)).toBe('file:c.ts');
  key('Digit7', { alt: true }); // no seventh tab: nothing
  expect(active(s)).toBe('file:c.ts');
});

it('in a text field: Alt and Ctrl bindings work, Alt+←/→ and the plain keys do not', () => {
  const s = setup();
  const box = document.getElementById('composer-input')!;
  key('Digit2', { alt: true }, box);
  expect(active(s)).toBe('file:a.ts');
  key('ArrowRight', { alt: true }, box); // the field's own word jump
  expect(active(s)).toBe('file:a.ts');
  key('KeyF', { mod: true, shift: true }, box);
  expect(s.getState().tree.open).toBe(false);
});

it('Ctrl+Shift+F and Ctrl+Shift+C toggle the panels; Alt+E toggles recent files; Alt+F1 reveals the active file', async () => {
  const s = setup(['src/deep/x.ts']);
  const tree = s.getState().tree.open;
  key('KeyF', { mod: true, shift: true });
  expect(s.getState().tree.open).toBe(!tree);
  const panel = s.getState().comments.ui.panelOpen;
  key('KeyC', { mod: true, shift: true });
  expect(s.getState().comments.ui.panelOpen).toBe(!panel);
  key('KeyE', { mod: true }); // Ctrl/⌘+E is not ours (Claude in Chrome takes ⌘E)
  expect(recentModal.get()).toBe(false);
  key('KeyE', { alt: true });
  expect(await screen.findByRole('listbox', { name: /^Recent files/ })).toBeInTheDocument();
  expect(recentModal.get()).toBe(true);
  act(() => recentModal.close());
  key('F1', { alt: true });
  expect(s.getState().tree.open).toBe(true);
  expect(s.getState().tree.reveal).toBe('src/deep/x.ts');
  expect(s.getState().tree.dirs).toEqual(expect.arrayContaining(['src', 'src/deep']));
});

it('/ and Esc on empty space focus the composer; not inside a field, and not when someone else took the key', () => {
  setup();
  const box = document.getElementById('composer-input')!;
  fireEvent.keyDown(document.body, { code: 'Slash', key: '/', bubbles: true });
  expect(document.activeElement).toBe(box);
  box.blur();
  key('Escape');
  expect(document.activeElement).toBe(box);
  box.blur();
  // a handler before ours consumed it (the Esc protocol)
  const taken = (e: KeyboardEvent) => e.preventDefault();
  document.addEventListener('keydown', taken, true);
  key('Escape');
  document.removeEventListener('keydown', taken, true);
  expect(document.activeElement).not.toBe(box);
  // typing "/" in another field types it
  const other = document.createElement('input');
  document.body.appendChild(other);
  other.focus();
  fireEvent.keyDown(other, { code: 'Slash', key: '/', bubbles: true });
  expect(document.activeElement).toBe(other);
  other.remove();
});

it('the ? help lists every hotkey with its keys', () => {
  expect(BINDINGS.map(keysLabel)).toEqual([
    'Alt+W', 'Alt+Shift+T', 'Alt+←', 'Alt+→', 'Alt+1…9', 'Alt+E', 'Ctrl+Shift+F', 'Ctrl+Shift+C', 'Alt+F1', '/, Esc',
  ]);
});

// ---- review regressions (Package B review)
const keyEv = (target: Element | Document, init: KeyboardEventInit) => fireEvent.keyDown(target, { bubbles: true, ...init });

it('a contenteditable="plaintext-only" field (a comment card being edited) is a text field: / types, Alt+→ stays', () => {
  const s = setup();
  const card = document.createElement('div');
  card.setAttribute('contenteditable', 'plaintext-only');
  document.body.appendChild(card);
  card.focus();
  const ev = new KeyboardEvent('keydown', { code: 'Slash', key: '/', bubbles: true, cancelable: true });
  card.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(document.activeElement).not.toBe(document.getElementById('composer-input'));
  key('ArrowRight', { alt: true }, card);
  expect(active(s)).toBe('file:c.ts');
  card.remove();
});

it('on a Mac: ⌘ is the mod key, Option+letter/digit types in a field but works outside; labels use ⌘⌥⇧', () => {
  const plat = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  try {
    const s = setup();
    // Option+W types ∑: matched by code outside a field
    keyEv(document.body, { code: 'KeyW', key: '∑', altKey: true });
    expect(ids(s)).toEqual(['chat', 'file:a.ts', 'file:b.ts']);
    // in a field Option+5 types [ on a German layout: no tab switch
    const box = document.getElementById('composer-input')!;
    keyEv(box, { code: 'Digit2', key: '“', altKey: true });
    expect(active(s)).toBe('file:b.ts');
    // Option+E (the ´ dead key) opens recent files, also from the composer; ⌘E does not
    keyEv(document.body, { code: 'KeyE', key: 'e', metaKey: true });
    expect(recentModal.get()).toBe(false);
    keyEv(box, { code: 'KeyE', key: 'Dead', altKey: true });
    expect(recentModal.get()).toBe(true);
    act(() => recentModal.close());
    expect(BINDINGS.map(keysLabel).slice(0, 2)).toEqual(['⌥W', '⌥⇧T']);
    expect(keysLabel(BINDINGS.find((b) => b.id === 'hk_files')!)).toBe('⌘⇧F');
  } finally {
    plat.mockRestore();
  }
});

it('AltGr (Ctrl+Alt off a Mac) is never ours; a key someone handled is skipped; / follows the layout', () => {
  const s = setup();
  keyEv(document.body, { code: 'Digit2', key: '@', altKey: true, ctrlKey: true });
  expect(active(s)).toBe('file:c.ts');
  const taken = (e: KeyboardEvent) => e.preventDefault();
  document.addEventListener('keydown', taken, true);
  key('KeyW', { alt: true });
  document.removeEventListener('keydown', taken, true);
  expect(ids(s)).toHaveLength(4);
  const box = document.getElementById('composer-input')!;
  // a Russian PC layout: the US Slash key types "." (not ours), Shift+7 types "/" (ours)
  keyEv(document.body, { code: 'Slash', key: '.' });
  expect(document.activeElement).not.toBe(box);
  keyEv(document.body, { code: 'Digit7', key: '/', shiftKey: true });
  expect(document.activeElement).toBe(box);
});

it('behind a modal dialog only Alt+E runs: the tabs behind the overlay stay', async () => {
  const s = setup();
  key('KeyE', { alt: true });
  const box = await screen.findByRole('combobox', { name: /searches the whole project/ });
  key('KeyW', { alt: true }, box);
  key('Digit1', { alt: true }, box);
  expect(ids(s)).toHaveLength(4);
  expect(active(s)).toBe('file:c.ts');
  key('KeyE', { alt: true }, box); // toggles its own dialog
  expect(recentModal.get()).toBe(false);
});

it('Esc on empty space focuses the composer and still stops a busy agent', () => {
  const sent: unknown[] = [];
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: (m: unknown) => (sent.push(m), true), close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/p', title: null, model: null })));
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'hi', ts: 1 } as never)));
  render(<Provider store={store}><App /></Provider>);
  key('Escape');
  expect(document.activeElement).toBe(document.getElementById('composer-input'));
  expect(sent).toContainEqual({ type: 'interrupt' });
});
