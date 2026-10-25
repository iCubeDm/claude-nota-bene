import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { HighlightLayer } from './HighlightLayer.tsx';

vi.mock('@/anchors/text.ts', async (orig) => {
  const real = await orig<typeof import('@/anchors/text.ts')>();
  return { ...real, rangeForAnchor: vi.fn(real.rangeForAnchor) };
});

const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;

beforeEach(() => {
  // jsdom has no layout: two line rects, plus a nested duplicate and a sliver that must be dropped
  Range.prototype.getClientRects = () =>
    [rect(10, 20, 100, 16), rect(12, 20, 40, 16), rect(0, 0, 1, 16), rect(10, 40, 60, 16)] as unknown as DOMRectList;
});
afterEach(() => {
  cleanup();
  vi.mocked(rangeForAnchor).mockClear();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getClientRects;
});

const comment = (o: Partial<Comment> & { quote?: string; start?: number; end?: number }): Comment => ({
  id: o.id ?? 'c1',
  anchor: { source: { kind: 'message', id: 'a1' }, start: o.start ?? 6, end: o.end ?? 17, quote: o.quote ?? 'brave world', prefix: 'hello ', suffix: '' },
  text: 'x', status: o.status ?? 'pending', createdAt: 1,
});

function setup(cs: Comment[], final = true) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const view = render(
    <Provider store={store}>
      <main data-chat-pane>
        <div id="items">
          <div data-kind="assistant" data-item-id="a1" data-final={String(final)}><p>hello brave world</p></div>
        </div>
        <HighlightLayer />
      </main>
    </Provider>,
  );
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: cs })));
  return { store, pane: view.container.querySelector('main')!, marks: () => view.container.querySelectorAll('[data-hl]') };
}

it('one box per line rect with the pending class', async () => {
  const { marks } = setup([comment({})]);
  await waitFor(() => expect(marks()).toHaveLength(2));
  expect(marks()[0].getAttribute('data-hl')).toBe('pending');
  expect(marks()[0].className).toContain('oklch(0.88_0.18_95/.38)');
  expect((marks()[0] as HTMLElement).style.left).toBe('8px'); // 10 - 2 padding
});

it('sent comments use the sent class', async () => {
  const { marks } = setup([comment({ status: 'sent' })]);
  await waitFor(() => expect(marks()).toHaveLength(2));
  expect(marks()[0].getAttribute('data-hl')).toBe('sent');
  expect(marks()[0].className).toContain('oklch(0.75_0.18_280/.18)');
});

it('an orphaned comment draws nothing', async () => {
  const { marks } = setup([comment({ quote: 'gone forever', start: 100, end: 112 })]);
  await act(() => new Promise((r) => setTimeout(r, 50)));
  expect(marks()).toHaveLength(0);
});

it('click on a mark opens its card', async () => {
  const { store, pane, marks } = setup([comment({})]);
  await waitFor(() => expect(marks()).toHaveLength(2));
  fireEvent.click(pane, { clientX: 20, clientY: 30 });
  expect(store.getState().comments.ui.card).toEqual({ id: 'c1', x: 10, y: 36 });
  store.dispatch({ type: 'comments/closeCommentCard' });
  fireEvent.click(pane, { clientX: 500, clientY: 500 });
  expect(store.getState().comments.ui.card).toBeNull();
});

const frames = () => act(() => new Promise((r) => setTimeout(r, 50)));

it('a repaint with the same comment object and live root reuses the cached range: no second text-model build', async () => {
  const { store, marks } = setup([comment({})]);
  await waitFor(() => expect(marks()).toHaveLength(2));
  expect(rangeForAnchor).toHaveBeenCalledTimes(1);
  act(() => void store.dispatch(serverEvent({ kind: 'user', id: 'u9', text: 'more', ts: 5 }))); // feed change -> repaint
  await frames();
  expect(marks()).toHaveLength(2);
  expect(rangeForAnchor).toHaveBeenCalledTimes(1);
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [comment({ status: 'sent' })] }))); // new object -> rebuilt
  await waitFor(() => expect(marks()[0]?.getAttribute('data-hl')).toBe('sent'));
  expect(rangeForAnchor).toHaveBeenCalledTimes(2);
});

it('a non-final (streaming) item draws nothing and builds nothing', async () => {
  const { marks } = setup([comment({})], false);
  await frames();
  expect(marks()).toHaveLength(0);
  expect(rangeForAnchor).not.toHaveBeenCalled();
});
