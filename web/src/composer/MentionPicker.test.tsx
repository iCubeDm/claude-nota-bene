import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL, type ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import type { PendingSelection } from '@/comments/SelectionButton.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

type Resolver = { q: string; resolve: (v: string[]) => void; signal?: AbortSignal | null };
let calls: Resolver[];
beforeEach(() => {
  setLang('en');
  vi.useFakeTimers();
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    const q = decodeURIComponent(String(url).split('q=')[1]);
    calls.push({ q, signal: init?.signal, resolve: (v) => resolve({ ok: true, json: async () => v }) });
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  box.focus();
  const type = (value: string) => {
    fireEvent.change(box, { target: { value } });
    box.setSelectionRange(value.length, value.length);
    fireEvent.input(box);
  };
  return { sent, store, box, type };
}
const flush = async (ms = 100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const answer = async (i: number, items: string[]) => { await act(async () => { calls[i].resolve(items); await Promise.resolve(); }); await flush(0); };

it('typing @ap queries q=ap after a debounce', async () => {
  const { type } = setup();
  type('see @ap');
  expect(calls).toHaveLength(0);
  await flush();
  expect(calls.map((c) => c.q)).toEqual(['ap']);
  await answer(0, ['src/app.ts']);
  expect(screen.getByRole('listbox')).toBeInTheDocument();
});

it('a leading quote is stripped from the query', async () => {
  const { type } = setup();
  type('@"my fi');
  await flush();
  expect(calls[0].q).toBe('my fi');
});

it('a stale response is ignored and the older fetch is aborted', async () => {
  const { type } = setup();
  type('@a');
  await flush();
  type('@ap');
  await flush();
  expect(calls[0].signal?.aborted).toBe(true);
  await answer(1, ['app.ts']);
  await answer(0, ['stale.ts']).catch(() => {});
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.getByRole('option').textContent).toContain('app.ts');
});

it('picking a path with whitespace inserts @"path" and updates the draft in the store', async () => {
  const { type, box, store } = setup();
  type('x @a');
  await flush();
  await answer(0, ['a b/c.md']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe('x @"a b/c.md" ');
  expect(store.getState().composer.draft).toBe('x @"a b/c.md" ');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('picking a folder inserts no space and keeps the picker open with a re-query', async () => {
  const { type, box } = setup();
  type('@sr');
  await flush();
  await answer(0, ['src/', 'src/a.ts']);
  fireEvent.keyDown(box, { key: 'Tab' });
  expect(box.value).toBe('@src/');
  await flush();
  expect(calls[1].q).toBe('src/');
  await answer(1, ['src/a.ts']);
  expect(screen.getByRole('listbox')).toBeInTheDocument();
});

it('Esc closes the picker, does not interrupt the agent', async () => {
  const { type, box, store } = setup();
  const spy = vi.spyOn(store, 'dispatch');
  type('@a');
  await flush();
  await answer(0, ['a.ts']);
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => { box.dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(true);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

it('Enter while open picks and does not send', async () => {
  const { type, box, sent } = setup();
  type('@a');
  await flush();
  await answer(0, ['a.ts']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('@a.ts ');
});

it('Cmd+Enter while open closes the picker and still sends', async () => {
  const { type, box, sent } = setup();
  type('@a');
  await flush();
  await answer(0, ['a.ts']);
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(sent).toHaveLength(1);
});

it('empty result shows the no-match note; a network error closes silently', async () => {
  const { type } = setup();
  type('@zz');
  await flush();
  await answer(0, []);
  expect(screen.getByText('no matches')).toBeInTheDocument();
  vi.mocked(fetch).mockRejectedValueOnce(new Error('down'));
  type('@zzzz');
  await flush();
  await flush(0);
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('a live :code after the @ belongs to the shortcode picker', async () => {
  const { type } = setup();
  type('@"a :smi');
  await flush();
  expect(calls).toHaveLength(0);
});

it('in the comment popup: Esc closes only the picker, the popup stays open', async () => {
  const pending: PendingSelection = {
    anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 1, quote: 'q', prefix: '', suffix: '' },
    rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
  };
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: () => true, close() {} })) as never });
  const onClose = vi.fn();
  render(<Provider store={store}><TooltipProvider><CommentPopup pending={pending} onClose={onClose} /></TooltipProvider></Provider>);
  const box = screen.getByPlaceholderText('Comment…') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '@a' } });
  box.setSelectionRange(2, 2);
  fireEvent.input(box);
  await flush();
  await answer(0, ['a.ts']);
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

it('Shift+Tab closes the picker without picking, so the composer can cycle the mode', async () => {
  const { type, box } = setup();
  type('@a');
  await flush();
  await answer(0, ['a.ts']);
  fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box.value).toBe('@a');
});

it('in a ! command the pick is the plain path, quoted only when the shell needs it', async () => {
  const { type, store, box } = setup();
  act(() => void store.dispatch(serverEvent({ kind: 'hello', protocol: PROTOCOL })));
  type('! cat @al');
  await flush();
  await answer(0, ['docs/alpha.md', 'my notes/it\'s.md']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe('! cat docs/alpha.md ');
  type('! cat @my');
  await flush();
  await answer(1, ['my notes/it\'s.md']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe("! cat 'my notes/it'\\''s.md' ");
});

it('against a server without shell mode ! is plain text and the pick stays an @ mention', async () => {
  const { type, box } = setup();
  type('! cat @al');
  await flush();
  await answer(0, ['docs/alpha.md']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe('! cat @docs/alpha.md ');
});

it('in a ! command a folder is a finished word: the picker does not keep going for its files', async () => {
  const { type, store, box } = setup();
  act(() => void store.dispatch(serverEvent({ kind: 'hello', protocol: PROTOCOL })));
  type('! ls @do');
  await flush();
  await answer(0, ['docs/']);
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe('! ls docs/ ');
});
