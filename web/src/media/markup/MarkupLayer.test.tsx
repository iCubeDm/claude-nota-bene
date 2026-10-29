import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaShape, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { connState, makeStore, serverEvent } from '@/store/store.ts';
import { MarkupLayer } from './MarkupLayer.tsx';
import { shapePath } from './geometry.ts';
import { addShape, selectDraft, setMode } from './slice.ts';

const TAB = 'file:p.png';
const rect = (x: number, y: number, w: number, h: number) => ({
  x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() { return this; },
}) as DOMRect;

let pane: HTMLDivElement;
beforeEach(() => {
  setLang('en');
  Element.prototype.setPointerCapture = () => {}; // jsdom has no pointer capture
  pane = document.createElement('div');
  pane.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  document.body.append(pane);
});
afterEach(() => { cleanup(); pane.remove(); vi.restoreAllMocks(); });

/** A 2000×1000 image letterboxed in a 1000×1000 element: content box (0, 250) 1000×500. */
function image() {
  const img = document.createElement('img');
  Object.defineProperty(img, 'naturalWidth', { value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { value: 1000 });
  img.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(img);
  return img;
}

function setup(media: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement = image(), protocol = 4, held = false) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(serverEvent({ kind: 'hello', protocol } as ServerEvent));
  const onAdd = vi.fn();
  const ui = () => (
    <Provider store={store}>
      <TooltipProvider>
        <MarkupLayer tabId={TAB} media={media} fit="contain" onAdd={onAdd} held={held} />
      </TooltipProvider>
    </Provider>
  );
  const r = render(ui());
  const dispatch = vi.spyOn(store, 'dispatch');
  return { store, r, onAdd, dispatch, ui, draft: () => selectDraft(store.getState(), TAB) };
}
const toggle = () => screen.getByRole('button', { name: /mark up/i });
const layer = () => pane.querySelector<SVGSVGElement>('svg[data-markup-layer]')!;
const drag = (pts: [number, number][]) => {
  const [first, ...rest] = pts;
  fireEvent.pointerDown(layer(), { button: 0, clientX: first[0], clientY: first[1], pointerId: 1, isPrimary: true });
  for (const [x, y] of rest) fireEvent.pointerMove(layer(), { clientX: x, clientY: y, pointerId: 1 });
  const last = pts[pts.length - 1];
  fireEvent.pointerUp(layer(), { clientX: last[0], clientY: last[1], pointerId: 1 });
};
const key = (k: Partial<KeyboardEventInit>) => fireEvent.keyDown(document.body, k);

it('the mode is not offered to a server below protocol 4', () => {
  setup(image(), 3);
  expect(screen.queryByRole('button', { name: /mark up/i })).toBeNull();
  cleanup();
  setup(image(), 4);
  expect(toggle()).toBeInTheDocument();
});

it('entering the mode pauses a playing video', () => {
  const v = document.createElement('video');
  v.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(v);
  let paused = false;
  Object.defineProperty(v, 'paused', { get: () => paused });
  const pause = vi.spyOn(v, 'pause').mockImplementation(() => { paused = true; });
  const { draft } = setup(v);
  fireEvent.click(toggle());
  expect(pause).toHaveBeenCalledTimes(1);
  expect(draft().on).toBe(true);
  expect(layer()).not.toBeNull();
});

it('the layer sits on the content box, inside the pane', () => {
  setup();
  fireEvent.click(toggle());
  expect(layer().parentElement).toBe(pane);
  const st = layer().style;
  expect([st.left, st.top, st.width, st.height]).toEqual(['0px', '250px', '1000px', '500px']);
});

it('a drag with the rect tool adds a rect in relative coordinates of the content box', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  // the content box is (0,250) 1000×500: x 100→300 is 0.1→0.3; y 350→450 is 0.2→0.4; dragged up-left
  drag([[300, 450], [200, 400], [100, 350]]);
  expect(draft().shapes).toEqual([{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.2, h: 0.2 }]);
  // outside the content box (the letterbox) clamps to the edge
  drag([[500, 100], [600, 50]]);
  expect(draft().shapes).toHaveLength(1); // zero height: not a shape
  drag([[500, 600], [1200, 900]]);
  expect(draft().shapes[1]).toEqual({ kind: 'rect', color: '#ff3b30', x: 0.5, y: 0.7, w: 0.5, h: 0.3 });
});

it('ellipse and arrow tools by key, a colour by digit (any keyboard layout)', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  key({ key: 'у', code: 'KeyE' }); // E on a Russian layout
  key({ key: '2', code: 'Digit2' });
  drag([[100, 250], [300, 750]]);
  key({ key: 'a', code: 'KeyA' });
  drag([[0, 250], [1000, 750]]);
  expect(draft().shapes).toEqual([
    { kind: 'ellipse', color: '#ffcc00', x: 0.1, y: 0, w: 0.2, h: 1 },
    { kind: 'arrow', color: '#ffcc00', x1: 0, y1: 0, x2: 1, y2: 1 },
  ]);
});

it('pen strokes update in place during the drag and are simplified on pointerup', () => {
  const { dispatch, draft } = setup();
  fireEvent.click(toggle());
  key({ key: 'p', code: 'KeyP' });
  dispatch.mockClear();
  const live = pane.querySelector('polyline[data-live]')!;
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: 100.5, clientY: 500, pointerId: 1 }); // 0.0005: dropped by simplify
  fireEvent.pointerMove(layer(), { clientX: 200, clientY: 500, pointerId: 1 });
  expect(live.getAttribute('points')).toBe('0.1,0.5 0.1005,0.5 0.2,0.5');
  fireEvent.pointerMove(layer(), { clientX: 300, clientY: 600, pointerId: 1 });
  expect(live.getAttribute('points')).toBe('0.1,0.5 0.1005,0.5 0.2,0.5 0.3,0.7');
  expect(dispatch).not.toHaveBeenCalled(); // no store update per move
  fireEvent.pointerUp(layer(), { clientX: 300, clientY: 600, pointerId: 1 });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(draft().shapes).toEqual([{ kind: 'pen', color: '#ff3b30', points: [0.1, 0.5, 0.2, 0.5, 0.3, 0.7] }]);
  expect(live.getAttribute('points')).toBe('');
  // a tap is a dot, never lost
  drag([[500, 500]]);
  expect(draft().shapes[1]).toEqual({ kind: 'pen', color: '#ff3b30', points: [0.5, 0.5, 0.5, 0.5] });
});

it('a live pen stroke appends each new point to both polylines (no rewrite of the whole points string per move)', () => {
  setup();
  fireEvent.click(toggle());
  key({ key: 'p', code: 'KeyP' });
  // jsdom has no SVGPointList: a browser-like one on the two live polylines and createSVGPoint on the svg
  (layer() as unknown as { createSVGPoint: () => { x: number; y: number } }).createSVGPoint = () => ({ x: 0, y: 0 });
  const lists = [...pane.querySelectorAll('polyline')].map((el) => {
    const items: { x: number; y: number }[] = [];
    Object.defineProperty(el, 'points', { configurable: true, value: { appendItem: (p: { x: number; y: number }) => (items.push(p), p) } });
    return { el, items, set: vi.spyOn(el, 'setAttribute') };
  });
  expect(lists).toHaveLength(2);
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: 200, clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(layer(), { clientX: 300, clientY: 600, pointerId: 1 });
  for (const l of lists) {
    expect(l.items).toEqual([{ x: 0.2, y: 0.5 }, { x: 0.3, y: 0.7 }]);
    // the stroke colour (live pen) and the first point at pointerdown, nothing per move
    expect(l.set.mock.calls.filter((c) => c[0] === 'points')).toEqual([['points', '0.1,0.5']]);
    expect(l.items[0]).not.toBe(lists[0] === l ? lists[1]!.items[0] : lists[0]!.items[0]); // one point object per list
  }
});

it('undo removes the last shape; Esc with shapes asks before discarding; Esc without shapes just leaves', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  drag([[300, 300], [400, 400]]);
  key({ key: 'z', code: 'KeyZ', metaKey: true });
  expect(draft().shapes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /undo/i }));
  expect(draft().shapes).toHaveLength(0);
  key({ key: 'Escape', code: 'Escape' });
  expect(draft().on).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(true); // the Composer does not also interrupt the agent
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  expect(draft().on).toBe(true);
  expect(draft().shapes).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /leave/i })); // ✕ asks too
  fireEvent.click(screen.getByRole('button', { name: /discard/i }));
  expect(draft()).toMatchObject({ on: false, shapes: [] });
});

it('keys are ignored in a text field and outside the mode; Enter comments with the shapes', () => {
  const { draft, onAdd, store } = setup();
  key({ key: 'p', code: 'KeyP' });
  expect(draft().tool).toBe('rect');
  fireEvent.click(toggle());
  const field = document.createElement('textarea');
  document.body.append(field);
  fireEvent.keyDown(field, { key: 'p', code: 'KeyP' });
  fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' });
  expect(draft()).toMatchObject({ tool: 'rect', on: true });
  field.remove();
  key({ key: 'Enter', code: 'Enter' });
  expect(onAdd).not.toHaveBeenCalled(); // nothing drawn
  const shape: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
  act(() => { store.dispatch(addShape(TAB, shape)); });
  key({ key: 'Enter', code: 'Enter' });
  expect(onAdd).toHaveBeenCalledWith([shape], expect.objectContaining({ width: expect.any(Number) }));
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(onAdd).toHaveBeenCalledTimes(2);
  expect(draft().shapes).toEqual([shape]); // the caller clears it once the comment exists
});

it('the draft survives a tab switch (the slice keeps it; the layer remounts with it)', () => {
  const { r, ui, store } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  r.unmount();
  expect(pane.querySelector('svg[data-markup-layer]')).toBeNull();
  render(ui());
  expect(selectDraft(store.getState(), TAB).on).toBe(true);
  expect(layer().querySelectorAll('path[data-shape]')).toHaveLength(1);
});

it('a hidden tab does not take the keys', () => {
  const { draft, store } = setup();
  act(() => { store.dispatch(setMode(TAB, true)); });
  pane.hidden = true;
  key({ key: 'p', code: 'KeyP' });
  expect(draft().tool).toBe('rect');
});

it('a dropped connection does not hide a drawing in progress', () => {
  const { store } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  act(() => { store.dispatch(connState('closed')); }); // protocol is 0 until the next hello
  expect(layer().querySelectorAll('path[data-shape]')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /leave/i })).toBeInTheDocument();
});

it('every shape has a dark halo under it, no CSS filter, the hit area outside any group', () => {
  setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  const shape = layer().querySelector('path[data-shape]')!;
  const halo = layer().querySelector('path[data-halo]')!;
  expect(halo.getAttribute('d')).toBe(shape.getAttribute('d'));
  expect(halo.compareDocumentPosition(shape) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // painted first
  expect(layer().innerHTML).not.toContain('filter');
  expect(layer().querySelector('rect')!.parentElement).toBe(layer());
});

it('the natural size known only after mount sizes the arrow head', () => {
  const img = document.createElement('img');
  let nat = [0, 0];
  Object.defineProperty(img, 'naturalWidth', { get: () => nat[0] });
  Object.defineProperty(img, 'naturalHeight', { get: () => nat[1] });
  img.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(img);
  const { draft } = setup(img);
  nat = [2000, 1000]; // loaded after the layer mounted, no load event seen
  fireEvent.click(toggle());
  key({ key: 'a', code: 'KeyA' });
  drag([[100, 400], [500, 500]]);
  expect(layer().querySelector('path[data-shape]')!.getAttribute('d')).toBe(shapePath(draft().shapes[0], 2000, 1000));
  nat = [1000, 2000];
  fireEvent.load(img); // a reload with another size
  expect(layer().querySelector('path[data-shape]')!.getAttribute('d')).toBe(shapePath(draft().shapes[0], 1000, 2000));
});

it('a tool or colour key pressed mid-drag does not change the shape being drawn', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  fireEvent.pointerDown(layer(), { button: 0, clientX: 100, clientY: 300, pointerId: 1 });
  key({ key: 'p', code: 'KeyP' });
  key({ key: '3', code: 'Digit3' });
  fireEvent.pointerMove(layer(), { clientX: 200, clientY: 400, pointerId: 1 });
  fireEvent.pointerUp(layer(), { clientX: 200, clientY: 400, pointerId: 1 });
  expect(draft().shapes).toEqual([{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.1, h: 0.2 }]);
  expect(draft()).toMatchObject({ tool: 'pen', color: '#34c759' }); // the next shape
});

it('Esc with focus inside the chat feed is not taken by the markup', () => {
  const { draft } = setup();
  fireEvent.click(toggle());
  drag([[100, 300], [200, 400]]);
  const feed = document.createElement('div');
  const link = document.createElement('a');
  link.href = '#x';
  feed.append(link);
  document.body.append(feed);
  link.focus();
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  act(() => { link.dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(false); // the Composer interrupts the agent
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.keyDown(link, { key: 'Enter', code: 'Enter' });
  expect(draft().on).toBe(true);
  feed.remove();
});

it('colour buttons are named', () => {
  setup();
  fireEvent.click(toggle());
  for (const n of ['Red (1)', 'Yellow (2)', 'Green (3)', 'Blue (4)', 'White (5)']) expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
});

it('Comment hands over the client rect around the drawn shapes (the popup opens there)', () => {
  const { onAdd, store } = setup();
  fireEvent.click(toggle());
  // content box (0, 250) 1000×500
  act(() => { store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })); });
  act(() => { store.dispatch(addShape(TAB, { kind: 'arrow', color: '#ff3b30', x1: 0.5, y1: 0.1, x2: 0.6, y2: 0.3 })); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  const r = onAdd.mock.calls[0]![1] as DOMRect;
  expect([r.left, r.top, r.width, r.height].map(Math.round)).toEqual([100, 300, 500, 250]);
});

it('shapes scrolled out of sight: the rect is the toolbar\'s', () => {
  const img = image();
  img.getBoundingClientRect = () => rect(0, -5000, 1000, 1000); // scrolled far up
  const { onAdd, store } = setup(img);
  fireEvent.click(toggle());
  act(() => { store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })); });
  const bar = screen.getByRole('toolbar');
  const tb = rect(800, 8, 180, 30);
  bar.getBoundingClientRect = () => tb;
  bar.parentElement!.getBoundingClientRect = () => rect(12, 8, 976, 30); // the pane-wide wrapper: not where it opens
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(onAdd.mock.calls[0]![1]).toBe(tb);
});

it('held (the comment popup is open): the mode keys are off', () => {
  const { draft, onAdd, store } = setup(image(), 4, true);
  fireEvent.click(toggle());
  act(() => { store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.1, h: 0.1 })); });
  key({ key: 'Enter', code: 'Enter' });
  key({ key: 'Escape', code: 'Escape' });
  key({ key: 'p', code: 'KeyP' });
  expect(onAdd).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(draft()).toMatchObject({ on: true, tool: 'rect' });
});


it('a 3D canvas is offered markup only from protocol 9 (an older server would drop the camera); the shapes use the canvas size', () => {
  const c = document.createElement('canvas');
  c.width = 2000;
  c.height = 1000;
  c.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(c);
  setup(c, 8);
  expect(screen.queryByRole('button', { name: /mark up/i })).toBeNull();
  cleanup();
  const s = setup(c, 9);
  fireEvent.click(toggle());
  expect(s.draft().on).toBe(true);
  expect(layer()).toBeTruthy();
  drag([[100, 300], [300, 500]]);
  const sh = s.draft().shapes[0];
  expect(sh).toMatchObject({ kind: 'rect', x: 0.1, w: 0.2 });
  expect((sh as { y: number }).y).toBeCloseTo(0.1, 5); // the 1000x500 content box sits at y 250
});
