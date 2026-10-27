import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, MediaAnchor } from '@nota-bene/shared';
import { Composer } from '@/composer/Composer.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { switchSession } from '@/controls/slice.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { CommentPopup, type PendingComment } from './CommentPopup.tsx';
import { labelText, QUICK_LABELS } from './labels.ts';
import { setPanelOpen } from './slice.ts';
import type { PendingSelection } from './SelectionButton.tsx';

const pending: PendingSelection = {
  anchor: { source: { kind: 'message', id: 'a1' }, start: 6, end: 17, quote: 'brave world', prefix: 'hello ', suffix: '' },
  rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
};

beforeEach(() => setLang('en'));
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function setup(p: PendingComment = pending, onAdded?: () => void) {
  const sent: ClientMessage[] = [];
  const store = makeStore({
    url: 'ws://x',
    connect: ((_u: string, _e: unknown, onState: (s: 'open') => void) => {
      onState('open');
      return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
    }) as never,
  });
  store.dispatch({ type: 'server/event', payload: { kind: 'hello', protocol: 3 } }); // a server that knows every label
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <p id="outside">outside</p>
        <Composer />
        <CommentPopup pending={p} onClose={onClose} onAdded={onAdded} />
      </TooltipProvider>
    </Provider>,
  );
  const comments = () => store.getState().comments.items;
  return { store, sent, onClose, comments };
}
const box = () => screen.getByPlaceholderText('Comment…');
/** Like setup, with the popup's `hidden` prop driven by the test. */
function setupHidable(p: PendingComment) {
  const store = makeStore({ url: 'ws://x', connect: (() => ({ send: () => true, close() {} })) as never });
  const ui = (hidden: boolean) => (
    <Provider store={store}>
      <TooltipProvider>
        <p id="outside">outside</p>
        <CommentPopup pending={p} onClose={() => {}} hidden={hidden} />
      </TooltipProvider>
    </Provider>
  );
  const r = render(ui(false));
  return { store, comments: () => store.getState().comments.items, rerender: (h: boolean) => r.rerender(ui(h)) };
}


it('shows the quote and focuses the textarea', () => {
  setup();
  expect(screen.getByText(/brave world/)).toBeInTheDocument();
  expect(box()).toHaveFocus();
});

it('⌘Enter adds with the typed text', () => {
  const { comments, onClose, store } = setup();
  fireEvent.change(box(), { target: { value: ' fix this ' } });
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ text: 'fix this', anchor: pending.anchor });
  expect(comments()[0].label).toBeUndefined();
  expect(onClose).toHaveBeenCalled();
  expect(store.getState().comments.ui.panelOpen).toBe(true);
});

it('Esc cancels without adding', () => {
  const { comments, onClose } = setup();
  fireEvent.change(box(), { target: { value: 'x' } });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(comments()).toHaveLength(0);
  expect(onClose).toHaveBeenCalled();
});

it('Esc is default-prevented so it never interrupts the agent', () => {
  setup();
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
});

it('a mousedown outside cancels; inside does not', () => {
  const { comments, onClose } = setup();
  fireEvent.mouseDown(box());
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(document.getElementById('outside')!);
  expect(onClose).toHaveBeenCalled();
  expect(comments()).toHaveLength(0);
});

it('an empty ⌘Enter adds nothing and closes', () => {
  const { comments, onClose } = setup();
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  expect(comments()).toHaveLength(0);
  expect(onClose).toHaveBeenCalled();
});

it('a chip adds a labelled comment in one click', () => {
  const { comments, onClose } = setup();
  fireEvent.change(box(), { target: { value: 'why' } });
  const chip = screen.getByRole('button', { name: 'Verify this' });
  fireEvent.click(chip);
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ label: 'verify', text: 'why' });
  expect(onClose).toHaveBeenCalled();
});

it('a chip with no text adds a label-only comment', () => {
  const { comments } = setup();
  fireEvent.click(screen.getByRole('button', { name: /Looks good/ }));
  expect(comments()[0]).toMatchObject({ label: 'looks-good', text: '' });
});

it('adding clears the DOM selection', () => {
  const { onClose } = setup();
  const r = document.createRange();
  r.selectNodeContents(document.getElementById('outside')!);
  window.getSelection()!.addRange(r);
  fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
  expect(window.getSelection()!.isCollapsed).toBe(true);
  expect(onClose).toHaveBeenCalled();
});

it('has the emoji button in its slot', () => {
  setup();
  expect(document.querySelector('[data-slot="emoji"]')!.querySelector('button[aria-label="Emoji"]')).not.toBeNull();
});

it('⌘Enter in the popup does not reach the composer', async () => {
  const { sent } = setup();
  const seen = vi.fn();
  document.addEventListener('keydown', seen);
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/Message the agent/), { target: { value: 'draft' } });
  });
  fireEvent.change(box(), { target: { value: 'c' } });
  const notPrevented = fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  document.removeEventListener('keydown', seen);
  expect(notPrevented).toBe(false);
  expect(seen).not.toHaveBeenCalled();
  expect(sent.filter((m) => m.type === 'send')).toHaveLength(0);
  expect(screen.getByPlaceholderText(/Message the agent/)).toHaveValue('draft');
});

vi.mock('@/attachments/image.ts', async (orig) => ({
  ...(await orig<typeof import('@/attachments/image.ts')>()),
  prepareImage: async (f: File) => f,
  uploadImage: async () => ({ id: 'e'.repeat(64), mediaType: 'image/png' }),
}));

it('a pasted image is saved on the comment (images-only is enough)', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  const { comments, onClose } = setup();
  const f = new File(['x'], 'a.png', { type: 'image/png' });
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files: [f], items: [] } });
  act(() => void box().dispatchEvent(ev));
  await waitFor(() => expect(document.querySelector('img[src^="/attach/"]:not([data-pending])')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(comments()[0]).toMatchObject({ text: '', images: ['e'.repeat(64)] });
  expect(onClose).toHaveBeenCalled();
});

it('while switching: Add and the quick labels are disabled with the switching tooltip, Cmd+Enter adds nothing', () => {
  const { store, comments, onClose } = setup();
  act(() => void store.dispatch(switchSession('x', '/r')));
  const add = screen.getByRole('button', { name: 'Add' });
  expect(add).toBeDisabled();
  expect(add).toHaveAttribute('title', 'switching…');
  const chips = screen.getAllByRole('button').filter((b) => b.closest('.flex-wrap'));
  expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) expect(chip).toBeDisabled();
  fireEvent.change(box(), { target: { value: 'x' } });
  fireEvent.keyDown(box(), { key: 'Enter', metaKey: true });
  expect(comments()).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();
});

it('quick-label chips show only the emoji; the label is the accessible name; at least 28px to click (M6-07)', () => {
  setup();
  const chip = screen.getByRole('button', { name: 'Looks good' });
  expect(chip).toHaveTextContent(/^👍$/);
  expect(chip.className).toMatch(/min-h-7/);
  expect(chip.className).toMatch(/min-w-7/);
  for (const l of QUICK_LABELS) {
    const b = screen.getByRole('button', { name: labelText(l.id) });
    expect(b.textContent).toBe(l.emoji);
  }
});

it('hovering a chip shows the label and the instruction in a tooltip', async () => {
  setup();
  fireEvent.focus(screen.getByRole('button', { name: 'Verify this' }));
  const tip = await screen.findByRole('tooltip');
  expect(tip).toHaveTextContent('Verify this');
  expect(tip).toHaveTextContent('Verify by reading the actual code');
});

it('while switching, a hovered chip explains why it is off', async () => {
  const { store } = setup();
  act(() => void store.dispatch(switchSession('x', '/r')));
  const chip = screen.getByRole('button', { name: 'Verify this' });
  fireEvent.focus(chip.parentElement!);
  expect(await screen.findByRole('tooltip')).toHaveTextContent('switching…');
});

it('opened by typing: the typed letter is in the field, the caret after it', async () => {
  setup({ ...pending, text: 'н' });
  const area = screen.getByRole('textbox', { name: 'Comment…' }) as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(area));
  expect(area.value).toBe('н');
  expect(area.selectionStart).toBe(1);
});

// ---- media comments (Task 6) ----

const MID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const mediaAnchor = (over: Partial<MediaAnchor> = {}): MediaAnchor => ({
  kind: 'media', source: { kind: 'file', path: 'media/scene_v6.png' }, width: 1000, height: 500,
  shapes: [
    { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    { kind: 'arrow', color: '#ffcc00', x1: 0.5, y1: 0.5, x2: 0.6, y2: 0.6 },
  ],
  ...over,
});
const deferred = <T,>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const FRAME = '1'.repeat(64), LAYER = '2'.repeat(64);

it('the popup quote for a media anchor shows the file and the shape count, not a text quote', () => {
  setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: async () => ({ images: [] }) });
  expect(screen.getByText('scene_v6.png · 2 shapes')).toBeInTheDocument();
  expect(screen.queryByText(/«/)).toBeNull();
});

it('a video quote has the time; one shape is singular', () => {
  const a = mediaAnchor({ source: { kind: 'file', path: 'clip.mp4' }, time: 4.24, shapes: [mediaAnchor().shapes[0]!] });
  setup({ ...pending, anchor: a, id: MID, prepare: async () => ({ images: [] }) });
  expect(screen.getByText('clip.mp4 @ 0:04.240 · 1 shape')).toBeInTheDocument();
});

it('Add on a media comment: no text needed; awaits prepare with a disabled spinner button, then adds with the id and [frame, layer]', async () => {
  const d = deferred<{ images: string[] }>();
  const onAdded = vi.fn();
  const { comments, onClose } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise }, onAdded);
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  const add = screen.getByRole('button', { name: 'Add' });
  expect(add).toBeDisabled();
  expect(add).toHaveAttribute('aria-busy', 'true');
  expect(comments()).toEqual([]);
  expect(onAdded).not.toHaveBeenCalled();
  await act(async () => d.resolve({ images: [FRAME, LAYER] }));
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ id: MID, text: '', anchor: mediaAnchor(), images: [FRAME, LAYER] });
  expect(onAdded).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalled();
});

it('a quick label on a media comment adds it labelled, after prepare', async () => {
  const { comments } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: async () => ({ images: [FRAME, LAYER] }) });
  fireEvent.change(box(), { target: { value: 'sit here' } });
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Verify this' })));
  expect(comments()[0]).toMatchObject({ id: MID, text: 'sit here', label: 'verify', images: [FRAME, LAYER] });
});

it('a failed prepare shows the error and keeps the popup open; nothing is added', async () => {
  const onAdded = vi.fn();
  const { comments, onClose } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: async () => { throw new Error('marks 500'); } }, onAdded);
  fireEvent.change(box(), { target: { value: 'keep me' } });
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Add' })));
  expect(screen.getByText(/Could not save the drawing.*marks 500/)).toBeInTheDocument();
  expect(comments()).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();
  expect(onAdded).not.toHaveBeenCalled();
  expect(box()).toHaveValue('keep me');
  expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled(); // a retry is possible
});

it('while Add saves, Esc and a click outside are ignored: the popup stays and the comment is added with the text', async () => {
  const d = deferred<{ images: string[] }>();
  const onAdded = vi.fn();
  const { comments, onClose } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise }, onAdded);
  fireEvent.change(box(), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false); // still taken (never reaches the agent), no close
  fireEvent.mouseDown(document.getElementById('outside')!);
  expect(onClose).not.toHaveBeenCalled();
  expect(box()).toHaveValue('keep me');
  await act(async () => d.resolve({ images: [FRAME, LAYER] }));
  expect(comments()).toHaveLength(1);
  expect(comments()[0]).toMatchObject({ id: MID, text: 'keep me', images: [FRAME, LAYER] });
  expect(onAdded).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('the popup unmounted while Add saves (its tab closed): the save still finishes and the comment is added, no DELETE', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const d = deferred<{ images: string[] }>();
    const onAdded = vi.fn();
    const { comments } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise }, onAdded);
    fireEvent.change(box(), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    cleanup();
    await act(async () => d.resolve({ images: [FRAME, LAYER] }));
    expect(comments()).toHaveLength(1);
    expect(comments()[0]).toMatchObject({ id: MID, text: 'keep me' });
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith(`/marks/${MID}`, expect.objectContaining({ method: 'DELETE' }));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('the popup unmounted while Add saves and the save fails: a toast says so and carries the typed text', async () => {
  resetToasts();
  const d = deferred<{ images: string[] }>();
  const { comments } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise });
  fireEvent.change(box(), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  cleanup();
  await act(async () => d.reject(new Error('marks 500')));
  expect(comments()).toEqual([]);
  expect(getToasts()).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/Could not save the drawing.*marks 500/), msg: expect.stringContaining('keep me') }));
});

it('a session switch that starts after the popup unmounted still aborts the save: no comment, /marks deleted', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const d = deferred<{ images: string[] }>();
    const { comments, store } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    cleanup(); // the tab closed: no more renders, so a render-time ref would never see the switch
    store.dispatch(switchSession('x', '/r'));
    await act(async () => d.resolve({ images: [FRAME, LAYER] }));
    expect(comments()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(`/marks/${MID}`, expect.objectContaining({ method: 'DELETE' }));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('a save that finishes after the user moved on (unmounted) leaves the DOM selection and the panel alone', async () => {
  const d = deferred<{ images: string[] }>();
  const { comments, store } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise });
  store.dispatch(setPanelOpen(false));
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  cleanup();
  const p = document.createElement('p');
  p.textContent = 'elsewhere';
  document.body.append(p);
  const r = document.createRange();
  r.selectNodeContents(p);
  window.getSelection()!.addRange(r);
  await act(async () => d.resolve({ images: [FRAME, LAYER] }));
  expect(comments()).toHaveLength(1);
  expect(window.getSelection()!.rangeCount).toBe(1); // (jsdom reports isCollapsed for any range: count instead)
  expect(store.getState().comments.ui.panelOpen).toBe(false);
  p.remove();
});

it('a save that finishes while the popup is hidden (its tab in the background) leaves the selection and the panel alone', async () => {
  const d = deferred<{ images: string[] }>();
  const { comments, store, rerender } = setupHidable({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise });
  store.dispatch(setPanelOpen(false));
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  rerender(true);
  const r = document.createRange();
  r.selectNodeContents(document.getElementById('outside')!);
  window.getSelection()!.addRange(r);
  await act(async () => d.resolve({ images: [FRAME, LAYER] }));
  expect(comments()).toHaveLength(1);
  expect(window.getSelection()!.rangeCount).toBe(1); // (jsdom reports isCollapsed for any range: count instead)
  expect(store.getState().comments.ui.panelOpen).toBe(false);
});

it('the anchor patch from prepare (scale, version, the exact time) lands on the comment', async () => {
  const { comments } = setup({
    ...pending, anchor: mediaAnchor({ time: 1 }), id: MID,
    prepare: async () => ({ images: [FRAME, LAYER], anchor: { scale: 0.75, version: 'W/"5-1"', time: 4.241 } }),
  });
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Add' })));
  expect(comments()[0]!.anchor).toEqual({ ...mediaAnchor(), scale: 0.75, version: 'W/"5-1"', time: 4.241 });
});

it('a session switch during prepare: no comment, and the popup stays busy until the folder is deleted', async () => {
  const del = deferred<Response>();
  const fetchMock = vi.fn(() => del.promise);
  vi.stubGlobal('fetch', fetchMock);
  try {
    const d = deferred<{ images: string[] }>();
    const { comments, store } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare: () => d.promise });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    act(() => void store.dispatch(switchSession('x', '/r')));
    await act(async () => d.resolve({ images: [FRAME, LAYER] }));
    expect(fetchMock).toHaveBeenCalledWith(`/marks/${MID}`, expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-busy', 'true'); // DELETE still in flight
    await act(async () => del.resolve(new Response(null, { status: 204 })));
    expect(screen.getByRole('button', { name: 'Add' })).not.toHaveAttribute('aria-busy');
    expect(comments()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('two clicks on Add in one tick start one prepare', async () => {
  const prepare = vi.fn(async () => ({ images: [FRAME, LAYER] }));
  const { comments } = setup({ ...pending, anchor: mediaAnchor(), id: MID, prepare });
  const add = screen.getByRole('button', { name: 'Add' });
  await act(async () => { add.click(); add.click(); }); // no re-render between them: only the ref can tell
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(comments()).toHaveLength(1);
});

it('the textarea grows with a long comment (the cap and the scrolling are CSS) and the popup keeps its side', () => {
  const h = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(180);
  const popH = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
  setup();
  const popup = box().parentElement!.closest<HTMLElement>('[style]')!; // the popup root (the textarea has its own height style)
  expect(popup.style.top).toBe('46px'); // below the selection (bottom 40 + 6)
  fireEvent.change(box(), { target: { value: 'a long comment\n'.repeat(12) } });
  expect(box().style.height).toBe('180px');
  expect(box().className).toMatch(/max-h-\[40vh\]/);
  popH.mockReturnValue(window.innerHeight); // grown taller than the room below: it moves up, never flips above the selection
  fireEvent.change(box(), { target: { value: 'a long comment\n'.repeat(40) } });
  expect(popup.style.top).toBe('8px');
  h.mockRestore();
  popH.mockRestore();
});
