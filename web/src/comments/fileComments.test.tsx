import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { App } from '@/App.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { jumpToFileComment } from '@/files/slice.ts';
import { activate, closeTab, fileTabId, openFile } from '@/tabs/slice.ts';
import { setPanelOpen } from './slice.ts';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;

let files: Record<string, string>;
let scrolled: Element[];
let scrolls: { el: Element; top?: number }[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  files = { 'docs/n.md': 'hello brave world\n\nsecond para\n' };
  scrolled = [];
  scrolls = [];
  // geometry from the range itself: a mark's left and a fragment's top follow its start offset, and a stale range
  // (its text node gone, or collapsed onto an element) has no box at all
  const live = (r: Range) => r.startContainer.nodeType === Node.TEXT_NODE && r.startContainer.isConnected && !r.collapsed;
  Range.prototype.getClientRects = function (this: Range) {
    return (live(this) ? [rect(this.startOffset * 10, 20, 100, 16)] : []) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function (this: Range) { return rect(0, 300 + this.startOffset * 10, 50, 16); };
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  Element.prototype.scrollTo = function (this: Element, o?: ScrollToOptions | number) { scrolls.push({ el: this, top: (o as ScrollToOptions).top }); } as never;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    const body = u.pathname === '/file' ? files[u.searchParams.get('path') ?? ''] : undefined;
    if (body === undefined) return new Response('nope', { status: 404 });
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(body.length) } });
    return new Response(body, { status: (init?.headers as Record<string, string> | undefined)?.Range ? 206 : 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getClientRects;
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

const fileComment = (o: Partial<Comment> = {}, quote = 'brave world', path = 'docs/n.md'): Comment => ({
  id: 'f1',
  anchor: { source: { kind: 'file', path }, start: 6, end: 6 + quote.length, quote, prefix: 'hello ', suffix: ' second para' },
  text: 'fix it', status: 'pending', createdAt: 1, ...o,
});
const chatComment: Comment = {
  id: 'm1', anchor: { source: { kind: 'message', id: 'u0' }, start: 0, end: 5, quote: 'first', prefix: '', suffix: '' },
  text: 'chat note', status: 'pending', createdAt: 1,
};

function setup(cs: Comment[], open: string[] = []) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  for (const p of open) store.dispatch(openFile(p));
  store.dispatch(setPanelOpen(true));
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u0', text: 'first message', ts: 0, historic: true }));
    store.dispatch(serverEvent({ kind: 'comments', items: cs }));
  });
  render(<Provider store={store}><App /></Provider>);
  return store;
}
const pane = (id: string) => document.querySelector<HTMLElement>(`[data-pane="${id}"]`)!;
const marksIn = (id: string) => pane(id).querySelectorAll('[data-hl]');
const frames = () => act(() => new Promise((r) => setTimeout(r, 50)));
const loaded = () => waitFor(() => expect(document.querySelector('[data-file-path="docs/n.md"]')?.textContent).toContain('hello brave world'));
const card = (id: string) => document.querySelector(`#comments [data-comment-id="${id}"]`)!;
const quoteOf = (id: string) => card(id).querySelector<HTMLElement>('.cursor-pointer')!;
/** Where scrollRangeIntoView puts a fragment in jsdom (pane rect, scrollTop and clientHeight all 0): its rect's middle. */
const target = (startOffset: number) => 300 + startOffset * 10 + 8;
const result = () => serverEvent({ kind: 'sdk', ts: 1, m: { type: 'result', subtype: 'success', duration_ms: 1 } } as never);

it('a file comment paints in its file pane and not in the chat; a chat comment only in the chat', async () => {
  setup([fileComment(), chatComment], ['docs/n.md']);
  await loaded();
  await waitFor(() => expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(1));
  expect(marksIn('chat')).toHaveLength(0); // the chat pane is hidden: it paints nothing, its own comment included
});

it('a hidden pane draws nothing and draws once it becomes active', async () => {
  const store = setup([fileComment(), chatComment], ['docs/n.md']);
  await loaded();
  await waitFor(() => expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(1));
  act(() => void store.dispatch(activate('chat')));
  await waitFor(() => expect(marksIn('chat')).toHaveLength(1));
  expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(0);
  act(() => void store.dispatch(activate(fileTabId('docs/n.md'))));
  await waitFor(() => expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(1));
  expect(marksIn('chat')).toHaveLength(0);
});

it('two open files with the same text: a comment on a.md marks only a.md', async () => {
  files = { 'a.md': 'hello brave world\n', 'b.md': 'hello brave world\n' };
  const store = setup([fileComment({}, 'brave world', 'a.md')], ['a.md', 'b.md']);
  await waitFor(() => expect(document.querySelector('[data-file-path="b.md"]')?.textContent).toContain('brave'));
  await frames();
  expect(marksIn(fileTabId('b.md'))).toHaveLength(0);
  act(() => void store.dispatch(activate(fileTabId('a.md'))));
  await waitFor(() => expect(marksIn(fileTabId('a.md'))).toHaveLength(1));
  expect(marksIn(fileTabId('b.md'))).toHaveLength(0);
});

it('a reload with changed text repaints from the new DOM, not the cached range; the quote gone orphans the comment', async () => {
  setup([fileComment()], ['docs/n.md']);
  await loaded();
  const mark = () => marksIn(fileTabId('docs/n.md'))[0] as HTMLElement | undefined;
  await waitFor(() => expect(mark()?.style.left).toBe('58px')); // "brave" at offset 6 of its text node, minus the 2px pad
  files['docs/n.md'] = 'well, hello brave world\n';
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(document.querySelector('[data-file-path]')?.textContent).toContain('well,'));
  // a stale cached range has no box (its text node is gone): only a re-resolved one paints, at the new offset 12
  await waitFor(() => expect(mark()?.style.left).toBe('118px'));
  expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(1);
  expect(card('f1')).not.toHaveTextContent('fragment changed');

  files['docs/n.md'] = 'entirely different words\n';
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(document.querySelector('[data-file-path]')?.textContent).toContain('entirely'));
  await frames();
  expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(0);
  await waitFor(() => expect(card('f1')).toHaveTextContent('fragment changed'));
});

it('an md file containing its own data-file-path element: roots, marks and orphan state stay on the tab’s file', async () => {
  files['docs/n.md'] = 'hello brave world\n\n<div data-file-path="x.md">nested words</div>\n';
  files['x.md'] = 'something else entirely\n';
  const store = setup([fileComment(), fileComment({ id: 'fx' }, 'nested words', 'x.md')], ['docs/n.md', 'x.md']);
  // docs/n.md (earlier in the DOM) loads first, so its nested x.md div exists when x.md's own view settles
  act(() => void store.dispatch(activate(fileTabId('docs/n.md'))));
  await waitFor(() => expect(pane(fileTabId('docs/n.md')).querySelector('[data-file-path="x.md"]')).not.toBeNull()); // survives sanitising
  await waitFor(() => expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(1));
  await frames();
  expect(marksIn(fileTabId('docs/n.md'))).toHaveLength(1); // x.md's comment is not painted on the nested element
  expect(card('f1')).not.toHaveTextContent('fragment changed');
  expect(card('fx')).not.toHaveTextContent('fragment changed'); // x.md not loaded yet: unknown
  act(() => void store.dispatch(activate(fileTabId('x.md'))));
  await waitFor(() => expect(pane(fileTabId('x.md')).getAttribute('data-file-path')).toBe('x.md'));
  // x.md's real text lacks the quote: orphaned, although the nested div in docs/n.md has it
  await waitFor(() => expect(card('fx')).toHaveTextContent('fragment changed'));
  await frames();
  expect(marksIn(fileTabId('x.md'))).toHaveLength(0);
});

it('a closed file tab: the comment is not orphaned; a deleted file once opened: orphaned', async () => {
  const store = setup([fileComment()]);
  await frames();
  expect(card('f1')).not.toHaveTextContent('fragment changed');
  delete files['docs/n.md'];
  act(() => void store.dispatch(openFile('docs/n.md')));
  await waitFor(() => expect(card('f1')).toHaveTextContent('fragment changed'));
  act(() => void store.dispatch(closeTab(fileTabId('docs/n.md'))));
  await waitFor(() => expect(card('f1')).not.toHaveTextContent('fragment changed'));
});

it('jump to source opens the closed file tab, then centres the fragment and flashes it', async () => {
  const store = setup([fileComment()]);
  expect(store.getState().tabs.open).toHaveLength(1);
  fireEvent.click(quoteOf('f1'));
  expect(store.getState().tabs.active).toBe(fileTabId('docs/n.md'));
  await waitFor(() => expect(scrolls).toHaveLength(1));
  expect(scrolls[0]).toEqual({ el: pane(fileTabId('docs/n.md')), top: target(6) });
  expect(pane(fileTabId('docs/n.md')).querySelector('.nb-flash')).not.toBeNull();
  expect(store.getState().files.jump).toBeNull(); // consumed once
  await frames();
  expect(scrolls).toHaveLength(1);
});

it('jump in a plain .txt file scrolls by the fragment’s rect, not to the middle of the <code> block', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => (i === 30 ? 'the TARGET line' : `line ${i}`));
  files['notes.txt'] = lines.join('\n') + '\n';
  setup([{ ...fileComment({}, 'TARGET', 'notes.txt'), anchor: { source: { kind: 'file', path: 'notes.txt' }, start: 0, end: 6, quote: 'TARGET', prefix: 'line 29 the ', suffix: ' line' } }]);
  fireEvent.click(quoteOf('f1'));
  await waitFor(() => expect(scrolls).toHaveLength(1));
  const node = [...document.querySelectorAll('[data-file-path="notes.txt"] code')].flatMap((c) => {
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    const out: Text[] = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
    return out;
  }).find((t) => t.data.includes('TARGET'))!;
  expect(scrolls[0]).toEqual({ el: pane(fileTabId('notes.txt')), top: target(node.data.indexOf('TARGET')) });
  expect(scrolled).toHaveLength(0); // no element scrollIntoView (that would centre the whole <code>)
});

it('jump to a chat comment from a file tab switches back to the chat and centres the fragment there', async () => {
  const store = setup([chatComment], ['docs/n.md']);
  await loaded();
  fireEvent.click(quoteOf('m1'));
  expect(store.getState().tabs.active).toBe('chat');
  expect(scrolls).toEqual([{ el: pane('chat'), top: target(0) }]);
});

it('a pending jump is dropped when another tab is activated', async () => {
  const store = setup([fileComment()]);
  act(() => {
    store.dispatch(jumpToFileComment('docs/n.md', 'f1'));
    store.dispatch(activate('chat'));
  });
  expect(store.getState().files.jump).toBeNull();
  act(() => void store.dispatch(activate(fileTabId('docs/n.md'))));
  await loaded();
  await frames();
  expect(scrolls).toHaveLength(0);
});

it('a pending jump is dropped by a jump to a chat comment', async () => {
  const store = setup([fileComment(), chatComment]);
  act(() => void store.dispatch(jumpToFileComment('docs/n.md', 'f1')));
  expect(store.getState().files.jump).not.toBeNull();
  fireEvent.click(quoteOf('m1'));
  expect(store.getState().files.jump).toBeNull();
  expect(scrolls).toEqual([{ el: pane('chat'), top: target(0) }]);
  act(() => void store.dispatch(activate(fileTabId('docs/n.md'))));
  await loaded();
  await frames();
  expect(scrolls).toHaveLength(1);
});

it('jump then 404: the tab opens, the comment is orphaned, the jump is consumed and nothing scrolls', async () => {
  delete files['docs/n.md'];
  const store = setup([fileComment()]);
  fireEvent.click(quoteOf('f1'));
  await waitFor(() => expect(card('f1')).toHaveTextContent('fragment changed'));
  expect(store.getState().files.jump).toBeNull();
  expect(scrolls).toHaveLength(0);
});

it('a turn while the jump is pending: the stale view reloads first and the jump lands in the new content', async () => {
  const store = setup([fileComment()], ['docs/n.md']);
  await loaded();
  act(() => void store.dispatch(activate('chat')));
  files['docs/n.md'] = 'some new intro: hello brave world\n';
  act(() => void store.dispatch(result())); // turnSeq++: the inactive view is stale
  fireEvent.click(quoteOf('f1'));
  await waitFor(() => expect(document.querySelector('[data-file-path]')?.textContent).toContain('new intro'));
  await waitFor(() => expect(scrolls).toHaveLength(1));
  expect(scrolls[0].top).toBe(target(22)); // "brave" in the reloaded text, not offset 6 of the old one
  await frames();
  expect(scrolls).toHaveLength(1);
});

it('two jumps in a row: the last one wins', async () => {
  const second: Comment = { ...fileComment({ id: 'f2' }), anchor: { source: { kind: 'file', path: 'docs/n.md' }, start: 18, end: 29, quote: 'second para', prefix: 'hello brave world ', suffix: '' } };
  const store = setup([fileComment(), second]);
  fireEvent.click(quoteOf('f1'));
  fireEvent.click(quoteOf('f2'));
  expect(store.getState().files.jump).toEqual({ path: 'docs/n.md', src: 'here', id: 'f2' });
  await waitFor(() => expect(scrolls).toHaveLength(1));
  expect(scrolls[0].top).toBe(target(0)); // "second para" starts its own paragraph
  await frames();
  expect(scrolls).toHaveLength(1);
});

it('a tab switch by keyboard hides the comment button of a chat selection', async () => {
  setup([], ['docs/n.md']);
  act(() => void fireEvent.click(screen.getByRole('tab', { name: /Chat/ })));
  const item = document.querySelector('[data-item-id="u0"]')!;
  const w = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let t = w.nextNode() as Text | null;
  while (t && !t.data.includes('first message')) t = w.nextNode() as Text | null;
  if (!t) throw new Error(item.outerHTML);
  const at = t.data.indexOf('first');
  const r = document.createRange();
  r.setStart(t, at);
  r.setEnd(t, at + 5);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(r);
  await act(async () => { fireEvent.mouseUp(item); await new Promise((res) => setTimeout(res, 0)); });
  expect(screen.getByRole('button', { name: '💬 Comment' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('tab', { name: /n\.md/ }), { key: 'Enter' });
  expect(screen.queryByRole('button', { name: '💬 Comment' })).toBeNull();
});

it('the tab badge counts only that file’s pending comments', async () => {
  setup([fileComment(), fileComment({ id: 'f2' }, 'x', 'other.md'), chatComment], ['docs/n.md']);
  expect(screen.getByRole('tab', { name: /n\.md/ }).querySelector('[data-badge]')).toHaveTextContent('1');
  expect(screen.getByRole('tab', { name: /Chat/ }).querySelector('[data-badge]')).toBeNull();
});
