import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { switchSession } from '@/controls/slice.ts';
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

// the button hides on tab switches, so it reads the store
const withStore = (ui: React.ReactElement, store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) })) =>
  render(<Provider store={store}><TooltipProvider>{ui}</TooltipProvider></Provider>);

function setup(items: string) {
  const onComment = vi.fn<(s: PendingSelection) => void>();
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const view = withStore(
    <main data-chat-pane>
      <div id="items" dangerouslySetInnerHTML={{ __html: items }} />
      <SelectionButton onComment={onComment} />
    </main>,
    store,
  );
  return { onComment, view, store, q: (id: string) => view.container.querySelector(`[data-item-id="${id}"]`)! };
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
  fireEvent.click(screen.getByRole('button', { name: '💬 Comment' }));
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
  expect(fireEvent.mouseDown(screen.getByRole('button', { name: '💬 Comment' }))).toBe(false);
});

it('Esc hides the button', async () => {
  await shown();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('button')).toBeNull();
});

it('Esc then a scroll does not bring the button back', async () => {
  const { view } = await shown();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.scroll(view.container.querySelector('[data-chat-pane]')!);
  expect(screen.queryByRole('button')).toBeNull();
});

it('the Esc after a dismissed button is not default-prevented (it reaches the composer)', async () => {
  const { view } = await shown();
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
  fireEvent.scroll(view.container.querySelector('[data-chat-pane]')!);
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
});

it('scrolling the chat pane keeps the button while the selection is visible', async () => {
  const { view } = await shown();
  const pane = view.container.querySelector<HTMLElement>('[data-chat-pane]')!;
  pane.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  fireEvent.scroll(pane);
  expect(screen.getByRole('button', { name: '💬 Comment' })).toBeInTheDocument();
});

it('scrolling the selection out of the pane hides the button', async () => {
  const { view } = await shown();
  const pane = view.container.querySelector<HTMLElement>('[data-chat-pane]')!;
  pane.getBoundingClientRect = () => ({ left: 0, right: 300, top: 100, bottom: 300, width: 300, height: 200, x: 0, y: 100, toJSON() {} }) as DOMRect;
  fireEvent.scroll(pane);
  expect(screen.queryByRole('button')).toBeNull();
});

it('scrolling after the selection collapsed hides the button', async () => {
  const { view } = await shown();
  const pane = view.container.querySelector<HTMLElement>('[data-chat-pane]')!;
  pane.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  window.getSelection()!.removeAllRanges();
  fireEvent.scroll(pane);
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
  const view = withStore(
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
  fireEvent.click(screen.getByRole('button', { name: '💬 Comment' }));
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

// ---- M3-13: selections in an open file view ----

function setupFile(html: string, outside = '') {
  const onComment = vi.fn<(s: PendingSelection) => void>();
  const view = withStore(
    <>
      <main data-chat-pane data-pane="chat" hidden><div id="items" dangerouslySetInnerHTML={{ __html: A }} /></main>
      <div data-pane="file:docs/n.md" data-file-path="docs/n.md" dangerouslySetInnerHTML={{ __html: html }} />
      <div id="outside" dangerouslySetInnerHTML={{ __html: outside }} />
      <SelectionButton onComment={onComment} />
    </>,
  );
  const root = view.container.querySelector<HTMLElement>('[data-file-path]')!;
  return { onComment, view, root };
}
const MD = '<div class="md"><h1>Title</h1><p>hello brave world</p></div>';

it('a selection in an md file view gives an anchor on that file', async () => {
  const { root, onComment } = setupFile(MD);
  const t = root.querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(root);
  fireEvent.click(screen.getByRole('button', { name: '💬 Comment' }));
  const { anchor } = onComment.mock.calls[0][0];
  expect(anchor.source).toEqual({ kind: 'file', path: 'docs/n.md' });
  expect(anchor.quote).toBe('brave');
  expect(anchor.prefix).toBe('Title hello '); // offsets in the rendered text of the whole file root
});

it('a selection from a file root into something outside is clipped to the file', async () => {
  const { root, view, onComment } = setupFile(MD, '<p>not the file</p>');
  const t = root.querySelector('p')!.firstChild!;
  const o = view.container.querySelector('#outside p')!.firstChild!;
  select(t, 6, o, 3);
  await up(root);
  fireEvent.click(screen.getByRole('button', { name: '💬 Comment' }));
  expect(onComment.mock.calls[0][0].anchor.quote).toBe('brave world');
});

it('scrolling the active file pane follows the selection; Esc then a scroll keeps it hidden', async () => {
  const { root } = setupFile(MD);
  root.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const t = root.querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(root);
  fireEvent.scroll(root);
  expect(screen.getByRole('button', { name: '💬 Comment' })).toBeInTheDocument();
  root.getBoundingClientRect = () => ({ left: 0, right: 300, top: 100, bottom: 300, width: 300, height: 200, x: 0, y: 100, toJSON() {} }) as DOMRect;
  fireEvent.scroll(root);
  expect(screen.queryByRole('button')).toBeNull(); // scrolled out of the file pane, not out of the (hidden) chat
  await up(root);
  fireEvent.keyDown(document, { key: 'Escape' });
  root.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 200, width: 300, height: 200, x: 0, y: 0, toJSON() {} }) as DOMRect;
  fireEvent.scroll(root);
  expect(screen.queryByRole('button')).toBeNull();
});

it('an md file whose content has its own data-file-path: the selection still anchors on the tab’s file', async () => {
  const { root, onComment } = setupFile('<div class="md"><p>hello</p><div data-file-path="x.md"><p>nested brave text</p></div></div>');
  const t = root.querySelector('[data-file-path="x.md"] p')!.firstChild!;
  select(t, 7, t, 12);
  await up(root);
  fireEvent.click(screen.getByRole('button', { name: '💬 Comment' }));
  const { anchor } = onComment.mock.calls[0][0];
  expect(anchor.source).toEqual({ kind: 'file', path: 'docs/n.md' });
  expect(anchor.quote).toBe('brave');
  expect(anchor.prefix).toBe('hello nested '); // offsets in the whole file root, not the nested element
});

it('a selection left in a hidden pane makes no button', async () => {
  const { view } = setupFile(MD);
  const chat = view.container.querySelector('[data-item-id="a1"] p')!.firstChild!; // the chat pane is hidden here
  select(chat, 6, chat, 11);
  await up(view.container.querySelector('[data-file-path]')!);
  expect(screen.queryByRole('button')).toBeNull();
});

it('no button on an interrupted reply (unstable stream:N id)', async () => {
  const { q } = setup('<div data-kind="assistant" data-item-id="stream:3" data-final="true"><p>interrupted text</p></div>');
  const t = q('stream:3').querySelector('p')!.firstChild!;
  select(t, 0, t, 5);
  await up(q('stream:3'));
  expect(screen.queryByRole('button')).toBeNull();
});

it('a mouseup inside a dialog does not re-show the button', async () => {
  const { q } = setup(A + '<div role="dialog"><span id="in">popup text</span></div>');
  const t = q('a1').querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(document.getElementById('in')!);
  expect(screen.queryByRole('button')).toBeNull();
  await up(q('a1')); // control: outside the dialog it shows
  expect(screen.getByRole('button', { name: '💬 Comment' })).toBeInTheDocument();
});

it('a selection made while switching shows no button', async () => {
  const store = makeStore({ url: 'ws://x', connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: () => true, close() {} })) as never });
  store.dispatch(switchSession('x', '/r'));
  const view = render(
    <Provider store={store}>
      <main data-chat-pane>
        <div id="items" dangerouslySetInnerHTML={{ __html: A }} />
        <SelectionButton onComment={vi.fn()} />
      </main>
    </Provider>,
  );
  const el = view.container.querySelector('[data-item-id="a1"]')!;
  const t = el.querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(el);
  expect(screen.queryByRole('button')).toBeNull();
});

it('the button has no transition, so it appears in place instead of flying in from 0,0 (M6-02)', async () => {
  const { q } = setup('<div data-item-id="a" data-kind="assistant" data-final="true">hello world</div>');
  const t = q('a').firstChild!;
  select(t, 0, t, 5);
  await up(q('a'));
  const b = screen.getByRole('button', { name: /comment/i });
  expect(b.className).toContain('transition-none');
  expect(b.className).not.toContain('transition-all');
  expect(screen.getByTestId('selection-bar').style.visibility).toBe('visible');
});

describe('one step to a comment', () => {
  async function shown() {
    const r = setup(A);
    const t = r.q('a1').querySelector('p')!.firstChild!;
    select(t, 6, t, 11);
    await up(r.q('a1'));
    return r;
  }

  it('a label chip next to the selection adds a labelled comment at once and opens the panel', async () => {
    const { store, onComment } = await shown();
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    const [c] = store.getState().comments.items;
    expect(c).toMatchObject({ label: 'looks-good', text: '', anchor: { quote: 'brave' } });
    expect(store.getState().comments.ui.panelOpen).toBe(true);
    expect(onComment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('selection-bar')).toBeNull();
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  it('an older server (no hello) is not offered 🔥, which it would refuse', async () => {
    await shown();
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['💬 Comment', 'Looks good', 'Clarify this', 'Verify this', 'Out of scope']);
  });

  it('typing a letter opens the popup with that letter', async () => {
    const { onComment } = await shown();
    const e = new KeyboardEvent('keydown', { key: 'п', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
    expect(onComment).toHaveBeenCalledWith(expect.objectContaining({ text: 'п', anchor: expect.objectContaining({ quote: 'brave' }) }));
    expect(screen.queryByTestId('selection-bar')).toBeNull();
  });

  it('Enter opens the popup empty', async () => {
    const { onComment } = await shown();
    act(() => { fireEvent.keyDown(document.body, { key: 'Enter' }); });
    expect(onComment).toHaveBeenCalledWith(expect.not.objectContaining({ text: expect.anything() }));
  });

  it('shortcuts, space and keys typed into a field are left alone', async () => {
    const { onComment } = await shown();
    const field = document.createElement('textarea');
    document.body.append(field);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'c', metaKey: true });
      fireEvent.keyDown(document.body, { key: ' ' });
      fireEvent.keyDown(document.body, { key: 'Shift' });
      fireEvent.keyDown(field, { key: 'a' });
    });
    field.remove();
    expect(onComment).not.toHaveBeenCalled();
    expect(screen.getByTestId('selection-bar')).toBeInTheDocument();
  });
});

it('with a server that knows it, 🔥 sits right after 👍 in the selection bar', async () => {
  const { store, q } = setup(A);
  act(() => void store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol: 3 } }));
  const t = q('a1').querySelector('p')!.firstChild!;
  select(t, 6, t, 11);
  await up(q('a1'));
  const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
  expect(names).toEqual(['💬 Comment', 'Looks good', 'Love it!', 'Clarify this', 'Verify this', 'Out of scope']);
  fireEvent.click(screen.getByRole('button', { name: 'Love it!' }));
  expect(store.getState().comments.items[0]).toMatchObject({ label: 'fire' });
});
