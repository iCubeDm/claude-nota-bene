import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { setFileVersion } from '@/files/slice.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import type { PipApi } from './mediaController.ts';
import { PlayerBar } from './PlayerBar.tsx';
import { selectDraft } from './markup/slice.ts';

const rect = (w: number) => ({ x: 0, y: 0, width: w, height: 20, left: 0, top: 0, right: w, bottom: 20, toJSON() { return this; } }) as DOMRect;
const PATH = 'v.mp4';
const TAB = `file:${PATH}`;

beforeEach(() => {
  setLang('en');
  // every element is 1000 px wide: the timeline's track too
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(1000));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(document, 'pictureInPictureEnabled'); });

const comment = (id: string, time: number | undefined, o: Partial<Comment> = {}): Comment => ({
  id, text: `text of ${id}`, status: 'pending', createdAt: 1,
  anchor: { kind: 'media', source: { kind: 'file', path: PATH }, width: 320, height: 240, shapes: [], ...(time !== undefined && { time }) },
  ...o,
});

/** A stub element: jsdom plays nothing, so state lives here and the events are fired by hand. */
function setup(o: { tag?: 'video' | 'audio'; comments?: Comment[]; pip?: PipApi; protocol?: number } = {}) {
  const el = document.createElement(o.tag ?? 'video');
  const st = { time: 20, duration: 100, paused: true, ended: false, volume: 0.5, muted: false, rate: 1 };
  const def = (k: string, get: () => unknown, set?: (v: never) => void) => Object.defineProperty(el, k, { get, set, configurable: true });
  def('currentTime', () => st.time, (v: number) => void (st.time = v));
  def('duration', () => st.duration);
  def('paused', () => st.paused);
  def('ended', () => st.ended);
  def('volume', () => st.volume, (v: number) => void (st.volume = v));
  def('muted', () => st.muted, (v: boolean) => void (st.muted = v));
  def('playbackRate', () => st.rate, (v: number) => void (st.rate = v));
  def('readyState', () => 4);
  const play = vi.fn(() => { st.paused = false; return Promise.resolve(); });
  const pause = vi.fn(() => { st.paused = true; });
  el.play = play;
  el.pause = pause;
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }), ...(o.pip && { pip: o.pip }) });
  act(() => {
    store.dispatch(serverEvent({ kind: 'hello', protocol: o.protocol ?? 4 } as ServerEvent));
    store.dispatch(serverEvent({ kind: 'comments', items: o.comments ?? [] }));
  });
  const box = { current: document.createElement('div') as HTMLElement | null };
  document.body.append(box.current!);
  const r = render(<Provider store={store}><PlayerBar media={el} box={box} tabId={TAB} path={PATH} flash={null} /></Provider>);
  const fire = (ev: string) => act(() => void el.dispatchEvent(new Event(ev)));
  const slider = () => screen.getByRole('slider', { name: 'Seek' });
  return { el, st, store, r, play, pause, fire, slider, box };
}
const ticks = () => [...document.querySelectorAll<HTMLElement>('[data-marker]')];

it('play/pause button toggles through the player key logic and follows the element', () => {
  const s = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Play (K)' }));
  expect(s.play).toHaveBeenCalledTimes(1);
  s.fire('play');
  fireEvent.click(screen.getByRole('button', { name: 'Pause (K)' }));
  expect(s.pause).toHaveBeenCalledTimes(1);
  s.st.ended = true; s.fire('ended');
  expect(screen.getByRole('button', { name: 'Replay' })).toBeTruthy();
});

it('shows the time and the slider values', () => {
  const s = setup();
  expect(screen.getByText('0:20 / 1:40')).toBeTruthy();
  const sl = s.slider();
  expect([sl.getAttribute('aria-valuemin'), sl.getAttribute('aria-valuemax'), sl.getAttribute('aria-valuenow'), sl.getAttribute('aria-valuetext')]).toEqual(['0', '100', '20', '0:20 of 1:40']);
});

it('a press on the timeline at x seeks to x/width of the duration; dragging keeps seeking, the pointer up ends it', () => {
  const s = setup();
  fireEvent.pointerDown(s.slider(), { clientX: 250, button: 0, pointerId: 1 });
  expect(s.st.time).toBe(25);
  fireEvent.pointerMove(s.slider(), { clientX: 600, pointerId: 1 });
  expect(s.st.time).toBe(60);
  fireEvent.pointerMove(s.slider(), { clientX: 5000, pointerId: 1 });
  expect(s.st.time).toBe(100); // clamped
  fireEvent.pointerUp(s.slider(), { pointerId: 1 });
  fireEvent.pointerMove(s.slider(), { clientX: 100, pointerId: 1 });
  expect(s.st.time).toBe(100); // no longer scrubbing
});

it('the time tooltip follows the pointer', () => {
  const s = setup();
  fireEvent.pointerMove(s.slider(), { clientX: 500, pointerId: 1 });
  expect(document.querySelector('[data-timeline-tip]')?.textContent).toBe('0:50');
  fireEvent.pointerLeave(s.slider());
  expect(document.querySelector('[data-timeline-tip]')).toBeNull();
});

it('comment ticks: at their %, sent and other-version ones dimmed, near ones merged with a count, no time = no tick', () => {
  const s = setup({
    comments: [
      comment('a', 41), comment('b', 41.2), comment('sent', 80, { status: 'sent', sentIn: 'u' }),
      comment('old', 10, { anchor: { ...comment('x', 10).anchor, version: 'W/"1"' } }),
      comment('image-like', undefined),
    ],
  });
  expect(ticks().map((t) => [t.dataset.marker, t.dataset.count, t.style.left])).toEqual([['old', '1', '10%'], ['a b', '2', '41%'], ['sent', '1', '80%']]);
  const dim = (t: HTMLElement) => (t.firstElementChild as HTMLElement).style.opacity;
  expect(ticks().map(dim)).toEqual(['1', '1', '0.45']);
  expect(ticks()[1].getAttribute('aria-label')).toBe('0:41 · 2 comments');
  cleanup();
  // another version of the file is known now: the old one is dimmed too
  const { store } = setup({ comments: [comment('old', 10, { anchor: { ...comment('x', 10).anchor, version: 'W/"1"' } })] });
  expect(ticks().map(dim)).toEqual(['1']); // current version unknown: nothing to compare with
  act(() => void store.dispatch(setFileVersion({ path: PATH, version: 'W/"2"' })));
  expect(ticks().map(dim)).toEqual(['0.45']);
});

it('hovering a tick tells the time, the count and the start of the text', () => {
  setup({ comments: [comment('a', 41, { text: 'x'.repeat(60) }), comment('b', 41.1)] });
  fireEvent.pointerEnter(ticks()[0], { pointerId: 1 });
  const tip = document.querySelector('[data-timeline-tip]')!;
  expect(tip.textContent).toBe(`● 0:41 · 2 comments${'x'.repeat(40)}`);
  fireEvent.pointerLeave(ticks()[0], { pointerId: 1 });
  expect(document.querySelector('[data-timeline-tip]')).toBeNull();
});

it('a click on a tick seeks to exactly its time and pauses; it opens no markup and starts no scrub', () => {
  const s = setup({ comments: [comment('a', 41.237)] });
  s.st.paused = false;
  fireEvent.pointerDown(ticks()[0], { clientX: 412, button: 0, pointerId: 1 });
  fireEvent.click(ticks()[0]);
  expect(s.pause).toHaveBeenCalled();
  expect(s.st.time).toBe(41.237);
  expect(selectDraft(s.store.getState(), TAB).on).toBe(false);
});

it('mute, volume slider and speed menu act on the element', () => {
  const s = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Mute (M)' }));
  expect(s.st.muted).toBe(true);
  s.fire('volumechange');
  fireEvent.pointerDown(screen.getByRole('slider', { name: 'Volume' }), { clientX: 800, button: 0, pointerId: 1 });
  expect(s.st.muted).toBe(false);
  expect(s.st.volume).toBe(0.8);
  fireEvent.click(screen.getByRole('button', { name: 'Playback speed' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: '1.5×' }));
  expect(s.st.rate).toBe(1.5);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('fullscreen goes to the container, not the video', () => {
  const s = setup();
  const fs = vi.fn(() => Promise.resolve());
  s.box.current!.requestFullscreen = fs;
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen (F)' }));
  expect(fs).toHaveBeenCalledTimes(1);
});

it('the annotate button is the N key: pauses and turns the markup mode on; absent below protocol 4', () => {
  const s = setup();
  s.st.paused = false;
  fireEvent.click(screen.getByRole('button', { name: 'Annotate (N)' }));
  expect(s.pause).toHaveBeenCalled();
  expect(selectDraft(s.store.getState(), TAB).on).toBe(true);
  cleanup();
  setup({ protocol: 3 });
  expect(screen.queryByRole('button', { name: 'Annotate (N)' })).toBeNull();
});

it('the PiP button goes through the PipApi; hidden when the browser has none', async () => {
  const pip: PipApi = { request: vi.fn(() => Promise.resolve()), exit: vi.fn(() => Promise.resolve()), current: vi.fn(() => null) };
  setup({ pip });
  expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull(); // jsdom: not supported
  cleanup();
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
  const s = setup({ pip });
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect(pip.request).toHaveBeenCalledWith(s.el);
  // when this video is the PiP window, the button leaves it
  vi.mocked(pip.current).mockReturnValue(s.el);
  fireEvent.click(screen.getByRole('button', { name: 'Picture in picture' }));
  expect(pip.exit).toHaveBeenCalledTimes(1);
});

it('audio: the same bar without annotate, PiP, fullscreen or ticks, always shown', () => {
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
  setup({ tag: 'audio', comments: [comment('a', 5)] });
  for (const n of ['Annotate (N)', 'Picture in picture', 'Fullscreen (F)']) expect(screen.queryByRole('button', { name: n })).toBeNull();
  expect(ticks()).toHaveLength(0);
  expect(document.querySelector('[data-player-bar]')?.hasAttribute('inert')).toBe(false);
  expect(screen.getByRole('button', { name: 'Play (K)' })).toBeTruthy();
});

it('a video bar hides after 2.5 s of playing without the pointer, shows on movement, stays while paused', () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    const bar = () => document.querySelector('[data-player-bar]')!;
    expect(bar().hasAttribute('inert')).toBe(false);
    s.st.paused = false; s.fire('play');
    act(() => void vi.advanceTimersByTime(2600));
    expect(bar().hasAttribute('inert')).toBe(true);
    expect(s.box.current!.style.cursor).toBe('none');
    act(() => void s.box.current!.dispatchEvent(new Event('pointermove')));
    expect(bar().hasAttribute('inert')).toBe(false);
    act(() => void vi.advanceTimersByTime(2600));
    expect(bar().hasAttribute('inert')).toBe(true);
    s.st.paused = true; s.fire('pause');
    expect(bar().hasAttribute('inert')).toBe(false);
    expect(s.box.current!.style.cursor).toBe('');
  } finally {
    vi.useRealTimers();
  }
});

it('a video bar sits on the picture: its width and bottom edge, centred; a narrow picture gets the minimum width', () => {
  const rects = new Map<Element, DOMRect>();
  const R = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h, toJSON() { return this; } }) as DOMRect;
  vi.restoreAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rects.get(this) ?? R(0, 0, 1000, 20); });
  const mk = (vw: number, vh: number) => {
    const s = setup();
    Object.defineProperty(s.el, 'videoWidth', { value: vw, configurable: true });
    Object.defineProperty(s.el, 'videoHeight', { value: vh, configurable: true });
    rects.set(s.box.current!, R(0, 0, 1000, 800));
    rects.set(s.el, R(0, 0, 1000, 800));
    return s;
  };
  // 640x360 in a 1000x800 element: picture 1000x562.5 at y=118.75, so the bar is 1000 wide and 118.75 above the bottom
  const a = mk(640, 360);
  act(() => void a.el.dispatchEvent(new Event('loadedmetadata')));
  const bar = () => document.querySelector<HTMLElement>('[data-player-bar]')!;
  expect([bar().style.left, bar().style.width, bar().style.bottom]).toEqual(['0px', '1000px', '118.75px']);
  cleanup();
  // 100x400 in 1000x800: picture 200x800 at x=400; narrower than 360, so 360 wide centred on it (x=320)
  const b = mk(100, 400);
  act(() => void b.el.dispatchEvent(new Event('loadedmetadata')));
  expect([bar().style.left, bar().style.width, bar().style.bottom]).toEqual(['320px', '360px', '0px']);
});
