import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { Markdown } from '@/feed/Markdown.tsx';
import { takeStartAt } from '@/files/startAt.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectActiveTab } from '@/tabs/slice.ts';

const rect = (w: number) => ({ x: 0, y: 0, width: w, height: 20, left: 0, top: 0, right: w, bottom: 20, toJSON() { return this; } }) as DOMRect;
const st = { time: 20, paused: true };
const play = vi.fn(() => { st.paused = false; return Promise.resolve(); });
const pause = vi.fn(() => { st.paused = true; });

beforeEach(() => {
  setLang('en');
  st.time = 20;
  st.paused = true;
  play.mockClear();
  pause.mockClear();
  const P = HTMLMediaElement.prototype;
  Object.defineProperty(P, 'currentTime', { get: () => st.time, set: (v: number) => void (st.time = v), configurable: true });
  Object.defineProperty(P, 'duration', { get: () => 100, configurable: true });
  Object.defineProperty(P, 'paused', { get: () => st.paused, configurable: true });
  Object.defineProperty(P, 'readyState', { get: () => 4, configurable: true });
  P.play = play;
  P.pause = pause;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(1000));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const k of ['currentTime', 'duration', 'paused', 'readyState']) Reflect.deleteProperty(HTMLMediaElement.prototype, k);
  Reflect.deleteProperty(HTMLMediaElement.prototype, 'play');
  Reflect.deleteProperty(HTMLMediaElement.prototype, 'pause');
});

const comment = (id: string, time: number): Comment => ({
  id, text: `text of ${id}`, status: 'pending', createdAt: 1,
  anchor: { kind: 'media', source: { kind: 'file', path: 'v.mp4' }, width: 320, height: 240, shapes: [], time },
});

function mount(text: string, comments: Comment[] = []) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => {
    store.dispatch(serverEvent({ kind: 'hello', protocol: 4 } as ServerEvent));
    store.dispatch(serverEvent({ kind: 'comments', items: comments }));
  });
  const composer = document.createElement('textarea');
  document.body.append(composer);
  const r = render(<Provider store={store}><Markdown text={text} final /></Provider>);
  return { store, composer, ...r };
}
const ticks = () => [...document.querySelectorAll<HTMLElement>('[data-marker]')];
const key = (target: Element, code: string) => {
  fireEvent.keyDown(target, { code });
  fireEvent.keyUp(target, { code });
};

it('a chat video gets our bar and loses its native controls; audio and non-project media too', () => {
  const { container } = mount('![v](v.mp4)\n\n![a](a.mp3)\n\n![h](https://x.test/h.mp4)\n\n![p](/attach/abc.mp4)');
  const media = container.querySelectorAll('video, audio');
  expect(media).toHaveLength(4);
  for (const m of media) {
    expect(m.hasAttribute('controls')).toBe(false);
    expect(m.parentElement).toHaveClass('md-media');
    expect(m.parentElement!.querySelector('[data-player-bar]')).not.toBeNull();
  }
  // ⤢ only for project files
  expect(container.querySelectorAll('button.md-open-media')).toHaveLength(2);
  // no ✎ in the chat; the audio bar has no fullscreen
  expect(screen.queryByRole('button', { name: 'Annotate (N)' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Fullscreen (F)' })).toHaveLength(3);
});

it('streaming text keeps native controls (no bar until the reply is final)', () => {
  const { container } = render(<Markdown text="![v](v.mp4)" final={false} />);
  expect(container.querySelector('video')!.hasAttribute('controls')).toBe(true);
  expect(container.querySelector('[data-player-bar]')).toBeNull();
});

it('a project video shows its media comments as ticks; a click opens the tab at that time', () => {
  const { store } = mount('![v](v.mp4)\n\n![h](https://x.test/h.mp4)', [comment('a', 41), comment('b', 70)]);
  expect(ticks()).toHaveLength(2); // only the project file's bar
  fireEvent.click(ticks()[0]);
  expect(selectActiveTab(store.getState())).toMatchObject({ kind: 'file', path: 'v.mp4' });
  expect(takeStartAt('file:v.mp4')).toEqual({ at: 41, play: false });
  expect(st.time).toBe(20); // the chat copy is not seeked
});

it('a playing chat video pauses when "open" switches to its file tab, and the tab starts where it was, playing on (user, 2026-10-29)', () => {
  const { container, store } = mount('![v](v.mp4)');
  st.paused = false;
  st.time = 33;
  fireEvent.click(container.querySelector('button.md-open-media')!);
  expect(selectActiveTab(store.getState())).toMatchObject({ kind: 'file', path: 'v.mp4' });
  expect(pause).toHaveBeenCalled();
  expect(takeStartAt('file:v.mp4')).toEqual({ at: 33, play: true });
});

it('a bar narrower than 360 px drops speed and PiP', () => {
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
  try {
    mount('![v](v.mp4)');
    expect(screen.getByRole('button', { name: 'Playback speed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Picture in picture' })).toBeTruthy();
    cleanup();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(() => rect(300));
    mount('![v](v.mp4)');
    expect(screen.queryByRole('button', { name: 'Playback speed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Play (K)' })).toBeTruthy();
  } finally {
    Reflect.deleteProperty(document, 'pictureInPictureEnabled');
  }
});

it('keys: Space in the composer or before any click does not toggle; after a click on the video it toggles once', () => {
  const { container, composer } = mount('![v](v.mp4)');
  composer.focus();
  key(composer, 'Space');
  key(document.body, 'Space');
  expect(play).not.toHaveBeenCalled();
  const video = container.querySelector('video')!;
  fireEvent.pointerDown(video);
  expect(document.activeElement).toBe(video.parentElement);
  key(document.activeElement!, 'Space');
  expect(play).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();
  key(document.activeElement!, 'Space');
  expect(pause).toHaveBeenCalledTimes(1);
  // focus back in the composer: keys are off again
  composer.focus();
  key(composer, 'Space');
  expect(play).toHaveBeenCalledTimes(1);
});

it('keys act only on the focused player', () => {
  const { container } = mount('![a](a.mp4)\n\n![b](b.mp4)');
  const [a, b] = [...container.querySelectorAll('video')];
  fireEvent.pointerDown(b);
  key(document.activeElement!, 'Space');
  expect(play).toHaveBeenCalledTimes(1);
  expect(play.mock.contexts[0]).toBe(b);
  expect(a.parentElement).not.toBe(document.activeElement);
});
