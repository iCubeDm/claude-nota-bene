import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { Header } from '@/shell/Header.tsx';
import { makeStore, serverEvent } from '@/store/store.ts';
import { CommentPopup } from './CommentPopup.tsx';
import { CommentsPanel } from './CommentsPanel.tsx';

beforeEach(() => { setLang('en'); localStorage.clear(); });
afterEach(cleanup);

const cm = (id: string, o: Partial<Comment> = {}): Comment => ({
  id, anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 1, quote: 'x', prefix: '', suffix: '' },
  text: `text ${id}`, status: 'pending', createdAt: 1, ...o,
});

function setup(items: Comment[] = [], onSend = () => {}, open = true) {
  if (open) localStorage.setItem('panel:comments', '1'); // the initial open state is read from storage
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items })));
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Header />
        <CommentsPanel onSend={onSend} />
      </TooltipProvider>
    </Provider>,
  );
  return store;
}

it('toggle opens and closes and persists', () => {
  const store = setup([], () => {}, false);
  const toggle = screen.getByRole('button', { name: 'Comments' });
  expect(store.getState().comments.ui.panelOpen).toBe(false);
  fireEvent.click(toggle);
  expect(store.getState().comments.ui.panelOpen).toBe(true);
  expect(localStorage.getItem('panel:comments')).toBe('1');
  expect(document.getElementById('comments')).toHaveAttribute('data-open', 'true');
  fireEvent.click(document.getElementById('cClose')!);
  expect(store.getState().comments.ui.panelOpen).toBe(false);
  expect(localStorage.getItem('panel:comments')).toBe('0');
});

it('closing via × writes 0, hands focus to the toggle, and the closed aside is unreachable', () => {
  setup([cm('a')]);
  const x = document.getElementById('cClose')!;
  x.focus();
  fireEvent.click(x);
  expect(localStorage.getItem('panel:comments')).toBe('0');
  expect(document.activeElement).toBe(document.getElementById('toggleComments'));
  const aside = document.getElementById('comments')!;
  expect(aside).toHaveClass('invisible');
  expect(aside).toHaveAttribute('aria-hidden', 'true');
});

it('adding a comment through the popup auto-opens the panel and persists 1', () => {
  const store = setup([], () => {}, false);
  const anchor = { source: { kind: 'message' as const, id: 'a1' }, start: 0, end: 1, quote: 'x', prefix: '', suffix: '' };
  render(
    <Provider store={store}>
      <TooltipProvider>
        <CommentPopup pending={{ anchor, rect: new DOMRect(0, 0, 10, 10) } as never} onClose={() => {}} />
      </TooltipProvider>
    </Provider>,
  );
  fireEvent.change(document.querySelector('textarea')!, { target: { value: 'hi' } });
  fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Enter', metaKey: true });
  expect(store.getState().comments.ui.panelOpen).toBe(true);
  expect(localStorage.getItem('panel:comments')).toBe('1');
});

it('persisting survives unavailable storage', () => {
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const store = setup([], () => {}, false);
  fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
  expect(store.getState().comments.ui.panelOpen).toBe(true);
  spy.mockRestore();
});

it('the badge shows the pending count', () => {
  setup([cm('a'), cm('b'), cm('c', { status: 'sent', sentIn: 'm1' })]);
  expect(screen.getByRole('button', { name: /Comments/ })).toHaveTextContent('Comments2');
  expect(document.getElementById('cTitle')).toHaveTextContent('Comments · 2');
  expect(screen.getByRole('button', { name: 'Send (2)' })).toBeEnabled();
  expect(document.querySelectorAll('[data-comment-id]')).toHaveLength(2);
});

it('the empty state is shown with no comments', () => {
  const onSend = vi.fn();
  setup([], onSend);
  expect(screen.getByText(/Select text in the chat/)).toHaveClass('whitespace-pre-line');
  expect(screen.getByRole('button', { name: 'Comments' })).toHaveTextContent(/^Comments$/);
  const send = screen.getByRole('button', { name: 'Send' });
  expect(send).toBeDisabled();
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
});

it('send calls onSend', () => {
  const onSend = vi.fn();
  setup([cm('a')], onSend);
  fireEvent.click(screen.getByRole('button', { name: 'Send (1)' }));
  expect(onSend).toHaveBeenCalledOnce();
});
