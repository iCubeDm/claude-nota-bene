import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Provider } from 'react-redux';
import { SelectionButton, type PendingSelection } from './SelectionButton.tsx';

beforeEach(() => {
  setLang('en');
  // jsdom has no layout: Range.getBoundingClientRect does not exist
  Range.prototype.getBoundingClientRect = () =>
    ({ left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} }) as DOMRect;
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

function setup(items: string) {
  const onComment = vi.fn<(s: PendingSelection) => void>();
  const view = render(
    <main data-chat-pane>
      <div id="items" dangerouslySetInnerHTML={{ __html: items }} />
      <SelectionButton onComment={onComment} />
    </main>,
  );
  return { onComment, view, q: (id: string) => view.container.querySelector(`[data-item-id="${id}"]`)! };
}

function select(a: Node, ao: number, b: Node, bo: number) {
  const r = document.createRange();
  r.setStart(a, ao);
  r.setEnd(b, bo);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
}
// the component reads the selection one tick after mouseup (the browser updates it after the event)
const up = (el: Element) =>
  act(async () => {
    fireEvent.mouseUp(el);
    await new Promise((r) => setTimeout(r, 0));
  });

const A = '<div data-kind="assistant" data-item-id="a1" data-final="true"><p>hello brave world</p></div>';
const S = '<div data-kind="assistant" data-item-id="a2" data-final="false"><p>streaming text</p></div>';

it('selection in a final reply shows the button', async () => {
  const { q } = setup(A);
  const t = q('a1').querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(q('a1'));
  expect(screen.getByRole('button', { name: '💬 Comment' })).toBeInTheDocument();
});

it('selection in a streaming reply does not', async () => {
  const { q } = setup(S);
  const t = q('a2').querySelector('p')!.firstChild!;
  select(t, 0, t, 9);
  await up(q('a2'));
  expect(screen.queryByRole('button')).toBeNull();
});

it('a selection spanning two items is clipped to the first', async () => {
  const { q, onComment } = setup(A + '<div data-kind="user" data-item-id="u1">second item</div>');
  const t1 = q('a1').querySelector('p')!.firstChild!;
  const t2 = q('u1').firstChild!;
  select(t1, 6, t2, 6);
  await up(q('u1'));
  fireEvent.click(screen.getByRole('button'));
  const sel = onComment.mock.calls[0][0];
  expect(sel.anchor.source).toEqual({ kind: 'message', id: 'a1' });
  expect(sel.anchor.quote).toBe('brave world');
  expect(sel.rect.bottom).toBe(40);
});

async function shown() {
  const r = setup(A);
  const t = r.q('a1').querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(r.q('a1'));
  return r;
}

it('mousedown on the button is default-prevented so the selection survives', async () => {
  await shown();
  expect(fireEvent.mouseDown(screen.getByRole('button'))).toBe(false);
});

it('Esc hides the button', async () => {
  await shown();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('button')).toBeNull();
});

it('scrolling the chat pane hides the button', async () => {
  const { view } = await shown();
  fireEvent.scroll(view.container.querySelector('[data-chat-pane]')!);
  expect(screen.queryByRole('button')).toBeNull();
});

it('collapsing the selection hides the button', async () => {
  const { q } = await shown();
  window.getSelection()!.removeAllRanges();
  await up(q('a1'));
  expect(screen.queryByRole('button')).toBeNull();
});

it('a selection starting in a tool or done line shows no button', async () => {
  const { q, view } = setup(
    '<div data-kind="tool">▸ Read · file</div><div data-kind="done">done · 3s</div>' + A,
  );
  const tool = view.container.querySelector('[data-kind="tool"]')!.firstChild!;
  const done = view.container.querySelector('[data-kind="done"]')!.firstChild!;
  select(tool, 2, tool, 6);
  await up(q('a1'));
  expect(screen.queryByRole('button')).toBeNull();
  select(done, 0, done, 4);
  await up(q('a1'));
  expect(screen.queryByRole('button')).toBeNull();
});

it('a selection outside #items (composer textarea, header) shows no button', async () => {
  const view = render(
    <>
      <header>app header</header>
      <main data-chat-pane><div id="items" dangerouslySetInnerHTML={{ __html: A }} /></main>
      <p id="outside">composer hint text</p>
      <SelectionButton onComment={() => {}} />
    </>,
  );
  for (const el of [view.container.querySelector('header')!, view.container.querySelector('#outside')!]) {
    select(el.firstChild!, 0, el.firstChild!, 3);
    await up(el);
    expect(screen.queryByRole('button')).toBeNull();
  }
});

it('a whole user bubble yields a quote without the meta header', async () => {
  const { q, onComment } = setup(
    '<div data-kind="user" data-item-id="u1"><div data-anchor-skip>you · 14:03</div>do the thing</div>',
  );
  const u = q('u1');
  select(u, 0, u, u.childNodes.length);
  await up(u);
  fireEvent.click(screen.getByRole('button'));
  expect(onComment.mock.calls[0][0].anchor.quote).toBe('do the thing');
});

it('Esc dismissing the button does not interrupt a busy agent; the next Esc does', async () => {
  const sent: ClientMessage[] = [];
  const store = makeStore({
    url: 'ws://x',
    connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => {
      onState('open');
      return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
    }) as never,
  });
  const view = render(
    <Provider store={store}>
      <TooltipProvider>
        <main data-chat-pane><div id="items" dangerouslySetInnerHTML={{ __html: A }} /></main>
        <Composer />
        <SelectionButton onComment={() => {}} />
      </TooltipProvider>
    </Provider>,
  );
  act(() => {
    store.dispatch({ type: 'server/event', payload: { kind: 'user', id: 'u9', text: 'x', ts: 0 } });
  });
  const t = view.container.querySelector('[data-item-id="a1"] p')!.firstChild!;
  select(t, 6, t, 11);
  await up(view.container.querySelector('[data-item-id="a1"]')!);
  expect(screen.getByRole('button', { name: '💬 Comment' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: '💬 Comment' })).toBeNull();
  expect(sent.filter((m) => m.type === 'interrupt')).toHaveLength(0);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(sent.filter((m) => m.type === 'interrupt')).toHaveLength(1);
});
