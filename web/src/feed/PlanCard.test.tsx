import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { whereOf } from '@/comments/send.ts';
import { SelectionButton, type PendingSelection } from '@/comments/SelectionButton.tsx';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Feed } from './Feed.tsx';

beforeEach(() => {
  setLang('en');
  Range.prototype.getBoundingClientRect = () => ({ left: 1, right: 2, top: 1, bottom: 2, width: 1, height: 1, x: 1, y: 1, toJSON() {} }) as DOMRect;
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

const input = { plan: '# Steps\n\nrefactor the parser' };

function setup(onComment: (s: PendingSelection) => void = () => {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: vi.fn(() => ({ send: (m: ClientMessage) => (sent.push(m), true), close() {} })) });
  const view = render(
    <Provider store={store}>
      <main data-chat-pane>
        <div id="items"><Feed /></div>
        <SelectionButton onComment={onComment} />
      </main>
    </Provider>,
  );
  act(() => {
    store.dispatch(serverEvent({ kind: 'mode', mode: 'acceptEdits' }));
    store.dispatch(serverEvent({ kind: 'mode', mode: 'plan' }));
    store.dispatch(serverEvent({ kind: 'permission', id: 'p1', toolName: 'ExitPlanMode', input, ts: 1 }));
  });
  return { sent, store, view };
}

it('an ExitPlanMode permission renders a plan card, not a permission card', () => {
  const { view } = setup();
  expect(view.container.querySelector('[data-kind="permission"]')).toBeNull();
  expect(screen.getByText('Plan ready — approve?')).toBeInTheDocument();
  expect(screen.getByText('refactor the parser')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve · continue in “Accept edits”' })).toBeInTheDocument();
});

it('approve remembers the mode to restore; the answered card stays', () => {
  const { sent, store } = setup();
  fireEvent.click(screen.getByRole('button', { name: /^Approve/ }));
  expect(sent).toContainEqual({ type: 'permission', id: 'p1', allow: true });
  expect(store.getState().controls.restoreAfterPlan).toBe('acceptEdits');
  act(() => void store.dispatch(serverEvent({ kind: 'permission-done', id: 'p1', allow: true, ts: 2 })));
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('✓ allowed')).toBeInTheDocument();
  expect(screen.getByText('refactor the parser')).toBeInTheDocument();
});

it('keep planning denies without input and does not restore', () => {
  const { sent, store } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }));
  expect(sent).toContainEqual({ type: 'permission', id: 'p1', allow: false });
  expect(store.getState().controls.restoreAfterPlan).toBeNull();
});

it('selecting plan text yields a plan: anchor, labelled as Plan', async () => {
  const onComment = vi.fn<(s: PendingSelection) => void>();
  const { view, store } = setup(onComment);
  const t = screen.getByText('refactor the parser').firstChild!;
  const r = document.createRange();
  r.setStart(t, 0);
  r.setEnd(t, 8);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(r);
  await act(async () => {
    fireEvent.mouseUp(view.container.querySelector('[data-kind="plan"]')!);
    await new Promise((x) => setTimeout(x, 0));
  });
  fireEvent.click(screen.getByRole('button', { name: /Comment/ }));
  const a = onComment.mock.calls[0]![0].anchor;
  expect(a.source).toEqual({ kind: 'message', id: 'plan:p1' });
  expect(whereOf({ anchor: a } as never, store.getState())).toBe('Plan');
});
