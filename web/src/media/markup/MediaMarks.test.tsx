import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, MediaAnchor, MediaShape } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { setFileVersion } from '@/files/slice.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { MediaMarks } from './MediaMarks.tsx';
import { setMode } from './slice.ts';

const TAB = 'file:p.png';
const rect = (x: number, y: number, w: number, h: number) => ({
  x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() { return this; },
}) as DOMRect;
const RED: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
const BLUE: MediaShape = { kind: 'arrow', color: '#0a84ff', x1: 0.5, y1: 0.5, x2: 0.7, y2: 0.6 };

const media = (path: string, shapes: MediaShape[], o: Partial<MediaAnchor> = {}): MediaAnchor =>
  ({ kind: 'media', source: { kind: 'file', path }, width: 2000, height: 1000, shapes, ...o });
const comment = (id: string, anchor: Comment['anchor'], o: Partial<Comment> = {}): Comment =>
  ({ id, anchor, text: id, status: 'pending', createdAt: 1, images: ['a'.repeat(64), 'b'.repeat(64)], ...o });

let pane: HTMLDivElement;
beforeEach(() => {
  setLang('en');
  pane = document.createElement('div');
  pane.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  document.body.append(pane);
});
afterEach(() => { cleanup(); pane.remove(); });

/** A 2000×1000 image letterboxed in a 1000×1000 element: content box (0, 250) 1000×500. */
function image() {
  const img = document.createElement('img');
  Object.defineProperty(img, 'naturalWidth', { value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { value: 1000 });
  img.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(img);
  return img;
}

/** A video whose paused state and time the test drives (events are fired by hand, as the element would). */
function video(w = 1000, h = 1000) {
  const v = document.createElement('video');
  let paused = false;
  Object.defineProperty(v, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(v, 'videoWidth', { value: w });
  Object.defineProperty(v, 'videoHeight', { value: h });
  v.getBoundingClientRect = () => rect(0, 0, 1000, 1000);
  pane.append(v);
  const at = (t: number, ev: string) => act(() => { paused = ev !== 'play'; v.currentTime = t; v.dispatchEvent(new Event(ev)); });
  return { v, pauseAt: (t: number) => at(t, 'pause'), seek: (t: number) => at(t, 'seeked'), play: () => at(v.currentTime, 'play') };
}

function setup(el: HTMLImageElement | HTMLVideoElement, items: Comment[], path = 'p.png', tabId = TAB) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items })));
  const r = render(<Provider store={store}><MediaMarks tabId={tabId} media={el} fit="contain" path={path} /></Provider>);
  return { store, r };
}
const marks = () => [...pane.querySelectorAll<SVGGElement>('svg[data-media-marks] g[data-mark]')];
const ids = () => marks().map((g) => g.dataset.mark);

it('marks of this file only, pending and sent styled differently', () => {
  setup(image(), [
    comment('mine', media('p.png', [RED])),
    comment('sent', media('p.png', [BLUE]), { status: 'sent', sentIn: 'u1' }),
    comment('other', media('q.png', [RED])),
    comment('branch', media('p.png', [RED], { source: { kind: 'file', path: 'p.png', ref: 'feat' } })),
    comment('text', { source: { kind: 'file', path: 'p.png' }, start: 0, end: 1, quote: 'x', prefix: '', suffix: '' }),
  ]);
  const svg = pane.querySelector<SVGSVGElement>('svg[data-media-marks]')!;
  expect(svg.parentElement).toBe(pane); // scrolls with the media
  expect([svg.style.left, svg.style.top, svg.style.width, svg.style.height]).toEqual(['0px', '250px', '1000px', '500px']);
  expect(ids()).toEqual(['sent', 'mine']); // pending painted last = on top
  const [sent, mine] = marks();
  expect(mine.getAttribute('opacity')).toBeNull();
  expect(sent.getAttribute('opacity')).toBe('0.35');
  // each shape in its own colour over a dark halo
  expect([...mine.querySelectorAll('path[data-shape]')].map((p) => p.getAttribute('stroke'))).toEqual(['#ff3b30']);
  expect(mine.querySelector('path[data-halo]')?.getAttribute('stroke')).toBe('rgba(0,0,0,0.55)');
  expect([...sent.querySelectorAll('path[data-shape]')].map((p) => p.getAttribute('stroke'))).toEqual(['#0a84ff']);
});

it('the overlay takes no pointer events except on the shapes', () => {
  setup(image(), [comment('mine', media('p.png', [RED]))]);
  const svg = pane.querySelector<SVGSVGElement>('svg[data-media-marks]')!;
  expect(svg.getAttribute('class')).toContain('pointer-events-none');
  const hits = [...svg.querySelectorAll<SVGPathElement>('[data-hit] path')];
  expect(hits).toHaveLength(1);
  expect(hits[0].getAttribute('pointer-events')).toBe('stroke');
  for (const p of svg.querySelectorAll('g[data-mark] path')) expect(p.getAttribute('pointer-events')).toBeNull();
});

it('a click on a mark opens its card', () => {
  const { store } = setup(image(), [comment('mine', media('p.png', [RED]))]);
  fireEvent.click(pane.querySelector('[data-hit="mine"] path')!, { clientX: 120, clientY: 300 });
  expect(store.getState().comments.ui.card).toEqual({ id: 'mine', x: 120, y: 300 });
});

it('marks stay drawn while the markup mode is on for that tab, but take no clicks', () => {
  const { store } = setup(image(), [comment('mine', media('p.png', [RED]))]);
  expect(ids()).toEqual(['mine']);
  expect(pane.querySelector('[data-hit="mine"]')).not.toBeNull();
  act(() => void store.dispatch(setMode(TAB, true)));
  expect(ids()).toEqual(['mine']);
  expect(pane.querySelector('[data-hit]')).toBeNull();
  act(() => void store.dispatch(setMode(TAB, false)));
  expect(pane.querySelector('[data-hit="mine"]')).not.toBeNull();
});

it('video marks hidden while playing or away from the time, shown when paused at it', () => {
  const v = video();
  setup(v.v, [comment('at4', media('v.mp4', [RED], { time: 4.24 })), comment('at9', media('v.mp4', [BLUE], { time: 9 }))], 'v.mp4', 'file:v.mp4');
  expect(ids()).toEqual([]); // playing (the test's video starts unpaused)
  v.pauseAt(4.24);
  expect(ids()).toEqual(['at4']);
  v.seek(4.27); // within 40 ms
  expect(ids()).toEqual(['at4']);
  v.seek(4.3);
  expect(ids()).toEqual([]);
  v.seek(9);
  expect(ids()).toEqual(['at9']);
  v.play();
  expect(ids()).toEqual([]);
});

it('the hit area leaves the bottom 48 px of a video free for its native controls', () => {
  // content box = element box (1000×1000): the bottom 48 px are clipped out of the hit area
  const full = video();
  setup(full.v, [comment('c', media('v.mp4', [RED], { time: 1 }))], 'v.mp4', 'file:v.mp4');
  full.pauseAt(1);
  expect(pane.querySelector('clipPath rect')?.getAttribute('height')).toBe('1.952') // y -1 … 0.952;
  expect(pane.querySelector('[data-hit]')?.getAttribute('clip-path')).toMatch(/^url\(#/);
  cleanup();
  pane.replaceChildren();
  // 2000×1000 letterboxed: the controls sit in the 250 px bar under the content, nothing to clip
  const wide = video(2000, 1000);
  setup(wide.v, [comment('c', media('v.mp4', [RED], { time: 1 }))], 'v.mp4', 'file:v.mp4');
  wide.pauseAt(1);
  expect(pane.querySelector('clipPath rect')?.getAttribute('height')).toBe('2');
});

it('a mark on a file that has changed since says so', () => {
  const { store } = setup(image(), [comment('mine', media('p.png', [RED], { version: 'W/"1-1"' }))]);
  expect(pane.querySelector('[data-hit="mine"] title')).toBeNull();
  act(() => void store.dispatch(setFileVersion({ path: 'p.png', version: 'W/"2-2"' })));
  expect(pane.querySelector('[data-hit="mine"] title')?.textContent).toBe('the file has changed since');
});

it('a sent mark of another version of the file is not drawn; a pending one still is (with its "file changed" title)', () => {
  const v1 = 'W/"1-1"';
  const { store } = setup(image(), [
    comment('pending-old', media('p.png', [RED], { version: v1 })),
    comment('sent-old', media('p.png', [BLUE], { version: v1 }), { status: 'sent', sentIn: 'u1' }),
    comment('sent-same', media('p.png', [BLUE], { version: 'W/"2-2"' }), { status: 'sent', sentIn: 'u1' }),
    comment('sent-unversioned', media('p.png', [BLUE]), { status: 'sent', sentIn: 'u1' }),
  ]);
  // the current version unknown: nothing to compare against, all shown
  expect(ids().sort()).toEqual(['pending-old', 'sent-old', 'sent-same', 'sent-unversioned']);
  act(() => void store.dispatch(setFileVersion({ path: 'p.png', version: 'W/"2-2"' })));
  expect(ids().sort()).toEqual(['pending-old', 'sent-same', 'sent-unversioned']);
  expect(pane.querySelector('g[data-hit="pending-old"] title')?.textContent).toMatch(/changed/i);
});
