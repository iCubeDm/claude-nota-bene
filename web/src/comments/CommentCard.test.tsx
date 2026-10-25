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
        {dom && <div id="items"><div data-item-id="a1" data-kind="user"><p>hello brave world</p></div></div>}
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

it('clicking the quote scrolls to the fragment, not the whole message, and flashes the message', () => {
  const targets: Element[] = [];
  const scroll = vi.fn(function (this: Element) { targets.push(this); });
  Element.prototype.scrollIntoView = scroll;
  setup();
  fireEvent.click(screen.getByText('brave world'));
  expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  expect(targets).toEqual([document.querySelector('[data-item-id="a1"] p')]);
  expect(document.querySelector('[data-item-id="a1"]')).toHaveClass('nb-flash');
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
