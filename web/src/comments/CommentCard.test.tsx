import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { CommentCard, CommentCardPopover } from './CommentCard.tsx';

beforeEach(() => setLang('ru'));
afterEach(cleanup);

const comment = (o: Partial<Comment> = {}): Comment => ({
  id: 'c1',
  anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
  text: 'original', status: 'pending', createdAt: 1, ...o,
});

function setup(c: Comment = comment(), dom = true, inFeed = true) {
  const sent: unknown[] = [];
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: (m: unknown) => (sent.push(m), true), close() {} }) });
  if (inFeed) act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'a1', text: 'hello brave world', ts: 0, historic: true })));
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [c] })));
  const view = render(
    <Provider store={store}>
      <TooltipProvider>
        {dom && <main data-chat-pane><div id="items"><div data-item-id="a1" data-kind="user"><p>hello brave world</p></div></div></main>}
        <CommentCard id={c.id} index={0} />
      </TooltipProvider>
    </Provider>,
  );
  return { store, sent, view };
}
const textOf = (store: ReturnType<typeof setup>['store']) => store.getState().comments.items[0]?.text;
const edit = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Редактировать' }));
  return document.querySelector<HTMLElement>('[contenteditable]')!;
};

it('edit saves on ⌘Enter', () => {
  const { store } = setup();
  const body = edit();
  body.textContent = 'changed';
  fireEvent.keyDown(body, { key: 'Enter', metaKey: true });
  expect(textOf(store)).toBe('changed');
  expect(document.querySelector('[contenteditable]')).toBeNull();
});

it('✕ reverts after typing', () => {
  const { store } = setup();
  const body = edit();
  body.textContent = 'changed';
  const no = screen.getByRole('button', { name: 'Отменить' });
  expect(fireEvent.mouseDown(no)).toBe(false); // preventDefault keeps focus, so blur cannot save first
  fireEvent.click(no);
  expect(textOf(store)).toBe('original');
  expect(screen.getByText('original')).toBeInTheDocument();
});

it('Esc reverts and does not bubble', () => {
  const { store } = setup();
  const outer = vi.fn();
  document.addEventListener('keydown', outer);
  const body = edit();
  body.textContent = 'changed';
  fireEvent.keyDown(body, { key: 'Escape' });
  document.removeEventListener('keydown', outer);
  expect(outer).not.toHaveBeenCalled();
  expect(textOf(store)).toBe('original');
});

it('blur saves', () => {
  const { store } = setup();
  const body = edit();
  body.textContent = 'changed';
  fireEvent.blur(body);
  expect(textOf(store)).toBe('changed');
});

it('delete removes', () => {
  const { store } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
  expect(store.getState().comments.items).toEqual([]);
});

it('an orphan shows the orphaned note', () => {
  setup(comment({ anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 12, quote: 'gone forever', prefix: '', suffix: '' } }));
  expect(screen.getByText(/фрагмент изменился/)).toBeInTheDocument();
});

it('no orphan note when the source item is not in the DOM', () => {
  setup(comment(), false);
  expect(screen.queryByText(/фрагмент изменился/)).toBeNull();
});

it('a source item missing from the feed (e.g. an interrupted stream:N reply after a restart) is an orphan', () => {
  setup(comment({ anchor: { source: { kind: 'message', id: 'stream:3' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' } }), false, false);
  expect(screen.getByText(/фрагмент изменился/)).toBeInTheDocument();
});

it('the help button has a single tooltip (no native title)', () => {
  setup();
  edit();
  const help = screen.getByRole('button', { name: /⌘Enter|Enter/ });
  expect(help).not.toHaveAttribute('title');
  expect(screen.getByRole('button', { name: 'Отменить' })).toHaveAttribute('title');
});

it('a sent comment is read-only', () => {
  setup(comment({ status: 'sent', sentIn: 'u1' }));
  expect(screen.queryByRole('button', { name: 'Редактировать' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
  expect(screen.getByText(/отправлено/)).toBeInTheDocument();
});

it('clicking the quote centres the fragment’s own rect in the chat pane and flashes the message', () => {
  const calls: { el: Element; top?: number }[] = [];
  Element.prototype.scrollTo = function (this: Element, o?: ScrollToOptions | number) { calls.push({ el: this, top: (o as ScrollToOptions).top }); } as never;
  Range.prototype.getBoundingClientRect = function (this: Range) {
    return { left: 0, top: 300 + this.startOffset, width: 50, height: 20, right: 50, bottom: 320 + this.startOffset, x: 0, y: 300, toJSON() {} } as DOMRect;
  };
  setup();
  const pane = document.querySelector<HTMLElement>('[data-chat-pane]')!;
  pane.getBoundingClientRect = () => ({ left: 0, top: 100, width: 300, height: 200, right: 300, bottom: 300, x: 0, y: 100, toJSON() {} }) as DOMRect;
  Object.defineProperty(pane, 'clientHeight', { value: 200, configurable: true });
  pane.scrollTop = 40;
  fireEvent.click(screen.getByText('brave world'));
  // scrollTop + (r.top - pane.top) - clientHeight/2 + r.height/2 = 40 + (306 - 100) - 100 + 10
  expect(calls).toEqual([{ el: pane, top: 156 }]);
  expect(document.querySelector('[data-item-id="a1"]')).toHaveClass('nb-flash');
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

it('clicking the quote of an orphan scrolls to the message itself', () => {
  const targets: Element[] = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) { targets.push(this); });
  setup(comment({ anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 12, quote: 'gone forever', prefix: '', suffix: '' } }));
  fireEvent.click(screen.getByText('gone forever'));
  expect(targets).toEqual([document.querySelector('[data-item-id="a1"]')]);
});

function popover() {
  const { store } = setup(comment(), true);
  const view = render(<Provider store={store}><TooltipProvider><CommentCardPopover /></TooltipProvider></Provider>);
  act(() => void store.dispatch({ type: 'comments/openCommentCard', payload: { id: 'c1', x: 10, y: 10 } }));
  return { store, view };
}

it('popover: Esc in edit mode reverts only; a second Esc closes', () => {
  const { store } = popover();
  fireEvent.click(screen.getAllByRole('button', { name: 'Редактировать' })[1]);
  const body = document.querySelector<HTMLElement>('[contenteditable]')!;
  body.textContent = 'changed';
  fireEvent.keyDown(body, { key: 'Escape' });
  expect(store.getState().comments.ui.card).not.toBeNull();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(store.getState().comments.ui.card).toBeNull();
});

it('popover: outside mousedown closes, deleting closes', () => {
  const { store } = popover();
  fireEvent.mouseDown(document.body);
  expect(store.getState().comments.ui.card).toBeNull();
  act(() => void store.dispatch({ type: 'comments/openCommentCard', payload: { id: 'c1', x: 10, y: 10 } }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Удалить' })[1]);
  expect(store.getState().comments.ui.card).toBeNull();
});

it('popover numbering: pending by its place among pending, sent by its place in its batch', () => {
  const sent = (id: string) => comment({ id, status: 'sent', sentIn: 'u1', text: id });
  const items = [comment({ id: 'p1', text: 'p1' }), sent('s1'), comment({ id: 'p2', text: 'p2' }), sent('s2')];
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'a1', text: 'hello brave world', ts: 0, historic: true })));
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items })));
  const view = render(<Provider store={store}><TooltipProvider><CommentCardPopover /></TooltipProvider></Provider>);
  const num = () => view.container.querySelector('[role="dialog"] .font-mono span')!.textContent!.split(' ')[0];
  const open = (id: string) => act(() => void store.dispatch({ type: 'comments/openCommentCard', payload: { id, x: 10, y: 10 } }));
  open('p2');
  expect(num()).toBe('2');
  open('s2');
  expect(num()).toBe('2');
  open('s1');
  expect(num()).toBe('1');
  // an in-flight pending id is not in selectPending, but the popover stays open
  open('p1');
  act(() => void store.dispatch({ type: 'comments/markSending', payload: ['p1'] }));
  expect(store.getState().comments.ui.card).not.toBeNull();
  expect(num()).toBe('1');
});

it('popover uses the popover background only', () => {
  const { view } = popover();
  const card = view.container.querySelector('[role="dialog"] [data-comment-id]')!;
  expect(card).toHaveClass('bg-popover');
  expect(card).not.toHaveClass('bg-card/50');
});

it('thumbnails of the comment sit outside the anchor text', () => {
  const H = 'a'.repeat(64);
  const { view } = setup(comment({ images: [H] }));
  const img = view.container.querySelector(`img[src="/attach/${H}"]`)!;
  expect(img).toBeTruthy();
  expect(img.closest('[data-anchor-skip]')).toBeTruthy();
  expect(img.getAttribute('loading')).toBe('lazy');
});

it('popover re-clamps into the viewport when the card resizes while editing', () => {
  let fire: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { fire = cb; } observe() {} unobserve() {} disconnect = disconnect; });
  let h = 100;
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => h });
  try {
    const { store } = setup(comment(), true);
    const view = render(<Provider store={store}><TooltipProvider><CommentCardPopover /></TooltipProvider></Provider>);
    act(() => void store.dispatch({ type: 'comments/openCommentCard', payload: { id: 'c1', x: 10, y: window.innerHeight - 150 } }));
    const dlg = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dlg.style.top).toBe(`${window.innerHeight - 150 + 6}px`); // fits below
    h = 400; // the edit box grew
    act(() => fire());
    expect(dlg.style.top).toBe(`${window.innerHeight - 150 - 400 - 6}px`); // now flipped above the anchor
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  }
});
