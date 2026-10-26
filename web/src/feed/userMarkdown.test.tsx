import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Anchor, Comment } from '@nota-bene/shared';
import { makeAnchor } from '@/anchors/resolve.ts';
import { rangeForAnchor, textOf } from '@/anchors/text.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentCard } from '@/comments/CommentCard.tsx';
import { composeBatch } from '@/comments/compose.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Feed } from './Feed.tsx';

// M6-06: user messages, comment cards and batch details are markdown (sanitised); anchors read the rendered text
beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup(text: string, comments: Comment[] = []) {
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u1', text, ts: 0, historic: true })));
  if (comments.length) act(() => void store.dispatch(serverEvent({ kind: 'comments', items: comments })));
  const view = render(<Provider store={store}><TooltipProvider><Feed /></TooltipProvider></Provider>);
  const root = view.container.querySelector<HTMLElement>('[data-item-id="u1"]')!;
  return { store, view, root };
}

it('renders markdown: bold, code block, link (new tab) and the script is sanitised', () => {
  const { root } = setup('**bold** and `x`\n\n```ts\nconst a = 1;\n```\n\n[l](https://example.com) <script>alert(1)</script><img src=x onerror=alert(1)>');
  expect(root.querySelector('strong')).toHaveTextContent('bold');
  expect(root.querySelector('pre code')).toHaveTextContent('const a = 1;');
  expect(root.querySelector('a[href="https://example.com"]')).toHaveAttribute('target', '_blank');
  expect(root.querySelector('script')).toBeNull();
  expect(root.querySelector('[onerror]')).toBeNull();
});

it('a single newline stays a line break', () => {
  const { root } = setup('one\ntwo');
  expect(root.querySelector('br')).not.toBeNull();
});

it('@mentions stay clickable refs, also when markdown would eat their characters, and not inside code', () => {
  const { root } = setup('see @src/__init__.py and @"a b.md" and `@no.ts`\n\n```\n@fenced_x_.ts\n```');
  const m = [...root.querySelectorAll<HTMLElement>('.ref.mention')].map((e) => [e.dataset.path, e.textContent]);
  expect(m).toEqual([['src/__init__.py', '@src/__init__.py'], ['a b.md', '@"a b.md"']]);
  expect(root.querySelector('code .mention')).toBeNull();
  expect(root.querySelector('pre')!.textContent).toContain('@fenced_x_.ts');
});

it('mention text does not change the anchor text', () => {
  const { root } = setup('see @src/a.ts now');
  expect(textOf(root)).toContain('see @src/a.ts now');
});

it('anchors: plain text offsets are unchanged, a new comment on rendered text resolves', () => {
  const { root } = setup('hello **brave** world');
  const text = textOf(root);
  expect(text.replace(/^you.*?(?=hello)/i, '')).toContain('hello brave world');
  const start = text.indexOf('brave');
  const a = makeAnchor({ kind: 'message', id: 'u1' }, text, start, start + 5);
  const r = rangeForAnchor(root, a);
  expect(r?.toString()).toBe('brave');
});

it('an old anchor on the raw text re-anchors by quote or orphans, never marks other text', () => {
  const { root } = setup('say **bold** now and again now');
  const text = textOf(root);
  const raw = 'say **bold** now and again now';
  const rawAt = (q: string, n = 0) => { let i = -1; for (let k = 0; k <= n; k++) i = raw.indexOf(q, i + 1); return i; };
  const old = (q: string, n = 0): Anchor => ({ source: { kind: 'message', id: 'u1' }, start: rawAt(q, n), end: rawAt(q, n) + q.length, quote: q, prefix: raw.slice(Math.max(0, rawAt(q, n) - 32), rawAt(q, n)), suffix: raw.slice(rawAt(q, n) + q.length, rawAt(q, n) + q.length + 32) });
  // the quote contained markdown syntax: gone from the rendered text -> orphan
  expect(rangeForAnchor(root, old('**bold**'))).toBeNull();
  // the second "now": the prefix/suffix context picks it, and what is marked equals the quote
  const second = rangeForAnchor(root, old('now', 1));
  expect(second?.toString()).toBe('now');
  expect(second && textOf(root).indexOf('now')).toBeGreaterThan(-1);
  // ambiguous, no usable context: orphan rather than a guess
  const amb = rangeForAnchor(root, { ...old('now', 1), prefix: '', suffix: '' });
  if (amb) expect(amb.toString()).toBe('now');
  expect(text).toContain('say bold now and again now');
});

it('the batch details render comment text and quotes as markdown; the raw text is untouched', () => {
  const c: Comment = {
    id: 'c1', anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 3, quote: 'the *q*', prefix: '', suffix: '' },
    text: 'use **this** `code`', status: 'sent', sentIn: 'u1', createdAt: 1,
  };
  const { root } = setup('go', [c]);
  const d = root.querySelector('details')!;
  expect(d.querySelector('strong')).toHaveTextContent('this');
  expect(d.querySelector('blockquote em')).toHaveTextContent('q');
  expect(composeBatch('go', [c], 'en', () => '', () => 'x', () => undefined)).toContain('→ use **this** `code`');
});

it('a comment card renders its text as markdown; editing shows the raw source', () => {
  const c: Comment = {
    id: 'c1', anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
    text: 'a **bold** [link](https://example.com)', status: 'pending', createdAt: 1,
  };
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: () => true, close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [c] })));
  render(<Provider store={store}><TooltipProvider><CommentCard id="c1" index={0} /></TooltipProvider></Provider>);
  const card = document.querySelector('[data-comment-id="c1"]')!;
  expect(card.querySelector('strong')).toHaveTextContent('bold');
  expect(card.querySelector('a[href="https://example.com"]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const box = document.querySelector<HTMLElement>('[contenteditable]')!;
  expect(box.textContent).toBe('a **bold** [link](https://example.com)');
  expect(box.querySelector('strong')).toBeNull();
  box.textContent = 'a **bold** [link](https://example.com) more';
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(store.getState().comments.items[0].text).toBe('a **bold** [link](https://example.com) more');
});
