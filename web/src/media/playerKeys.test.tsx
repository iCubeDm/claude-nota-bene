import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { FileView } from '@/files/FileView.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectDraft } from './markup/slice.ts';
import { PLAYER_HELP } from './playerKeys.ts';
import { seekStep } from './seekStep.ts';
import { t } from '@/i18n/index.ts';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

beforeEach(() => {
  localStorage.clear();
  seekStep.reload();
  setLang('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** A media tab over jsdom, whose element is a recording stub (jsdom plays nothing). */
function setup(path = 'v.mp4', { protocol = 4, active = true }: { protocol?: number; active?: boolean } = {}) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(serverEvent({ kind: 'hello', protocol } as ServerEvent));
  const chat = document.createElement('div');
  chat.setAttribute('data-chat-pane', '');
  const feedBtn = document.createElement('button');
  const composer = document.createElement('textarea');
  chat.append(feedBtn, composer);
  document.body.append(chat);
  const strip = document.createElement('div');
  strip.setAttribute('role', 'tablist');
  const tabBtn = document.createElement('button');
  strip.append(tabBtn);
  document.body.append(strip);
  const r = render(<Provider store={store}><TooltipProvider><FileView path={path} active={active} /></TooltipProvider></Provider>);
  const el = r.container.querySelector<HTMLMediaElement>('video, audio');
  const st = { time: 20, volume: 0.5, muted: false, paused: true, duration: 100 };
  const play = vi.fn(() => { st.paused = false; return Promise.resolve(); });
  const pause = vi.fn(() => { st.paused = true; });
  if (el) {
    for (const k of ['volume', 'muted', 'paused', 'duration'] as const) Object.defineProperty(el, k, { get: () => st[k], set: (v: never) => void ((st as Record<string, unknown>)[k] = v), configurable: true });
    Object.defineProperty(el, 'currentTime', { get: () => st.time, set: (v) => void (st.time = v), configurable: true });
    el.play = play;
    el.pause = pause;
  }
  const press = (code: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init }));
  return { store, r, el, st, play, pause, press, chat, feedBtn, composer, tabBtn, tabId: `file:${path}` };
}

it('Space and K toggle play; the event is consumed', () => {
  const s = setup();
  expect(s.press('Space')).toBe(false); // dispatchEvent returns false when preventDefault was called
  expect(s.play).toHaveBeenCalledTimes(1);
  s.press('KeyK');
  expect(s.pause).toHaveBeenCalledTimes(1);
});

it('seeks: arrows ±5 s, J/L ±10 s, clamped to 0 and the duration; Home, End and digits jump', () => {
  const s = setup();
  s.press('ArrowRight'); expect(s.st.time).toBe(25);
  s.press('ArrowLeft'); s.press('ArrowLeft'); expect(s.st.time).toBe(15);
  s.press('KeyL'); expect(s.st.time).toBe(25);
  s.press('KeyJ'); s.press('KeyJ'); s.press('KeyJ'); expect(s.st.time).toBe(0);
  s.press('End'); expect(s.st.time).toBe(100);
  s.press('ArrowRight'); expect(s.st.time).toBe(100);
  s.press('Digit4'); expect(s.st.time).toBe(40);
  s.press('Numpad9'); expect(s.st.time).toBe(90);
  s.press('Digit0'); expect(s.st.time).toBe(0);
  s.st.time = 50; s.press('Home'); expect(s.st.time).toBe(0);
});

it('volume: ↑/↓ by 5 % clamped to 0..100, ↑ unmutes, M toggles mute', () => {
  const s = setup();
  s.press('ArrowUp'); expect(s.st.volume).toBe(0.55);
  s.press('ArrowDown'); s.press('ArrowDown'); expect(s.st.volume).toBe(0.45);
  s.st.volume = 0.98; s.press('ArrowUp'); expect(s.st.volume).toBe(1);
  s.st.volume = 0.02; s.press('ArrowDown'); expect(s.st.volume).toBe(0);
  s.press('KeyM'); expect(s.st.muted).toBe(true);
  s.press('ArrowUp'); expect(s.st.muted).toBe(false);
  s.press('KeyM'); s.press('KeyM'); expect(s.st.muted).toBe(false);
});

it('frame step only while paused, video only; F fullscreens the player container, not the video', () => {
  const s = setup();
  s.press('Period'); expect(s.st.time).toBeCloseTo(20 + 1 / 30);
  s.press('Comma'); expect(s.st.time).toBeCloseTo(20);
  s.st.paused = false;
  expect(s.press('Period')).toBe(true); // playing: not ours
  expect(s.st.time).toBeCloseTo(20);
  const fs = vi.fn(() => Promise.resolve());
  const own = vi.fn(() => Promise.resolve());
  const box = s.el!.closest<HTMLElement>('[data-pane]')!.parentElement!; // video → pane → container
  box.requestFullscreen = fs;
  s.el!.requestFullscreen = own;
  s.press('KeyF');
  expect(fs).toHaveBeenCalledTimes(1);
  expect(own).not.toHaveBeenCalled();
});

it('the frame step is not rounded to milliseconds: 30 steps are one second, no frame lost', () => {
  const s = setup();
  for (let i = 0; i < 30; i++) s.press('Period');
  expect(s.st.time).toBeCloseTo(21, 9);
});

it('audio: no fullscreen, no frame step, but the rest works', () => {
  const s = setup('s.mp3');
  expect(s.press('KeyF')).toBe(true);
  expect(s.press('Comma')).toBe(true);
  expect(s.press('KeyN')).toBe(true); // nothing to annotate
  s.press('Space');
  expect(s.play).toHaveBeenCalled();
  s.press('ArrowRight'); expect(s.st.time).toBe(25);
});

it('scope: focus in a text field or the chat does nothing; body, the tab strip and a button in the file header do', () => {
  const s = setup();
  s.composer.focus();
  expect(s.press('Space', {}, s.composer)).toBe(true);
  s.feedBtn.focus();
  expect(s.press('Space', {}, s.feedBtn)).toBe(true);
  expect(s.press('ArrowRight', {}, s.feedBtn)).toBe(true);
  expect(s.play).not.toHaveBeenCalled();
  s.tabBtn.focus();
  expect(s.press('Space', {}, s.tabBtn)).toBe(false);
  expect(s.play).toHaveBeenCalledTimes(1);
  const reload = s.r.container.querySelector<HTMLButtonElement>('button[aria-label]')!;
  reload.focus();
  expect(s.press('ArrowRight', {}, reload)).toBe(false);
  expect(s.st.time).toBe(25);
  (document.activeElement as HTMLElement).blur();
  expect(s.press('ArrowRight')).toBe(false);
});

it('scope: not inside a menu or dialog, not when the tab is hidden, not with a modifier', () => {
  const s = setup();
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  const item = document.createElement('button');
  menu.append(item);
  s.r.container.querySelector('[data-file-view]')!.append(menu); // even inside the file view
  item.focus();
  expect(s.press('Space', {}, item)).toBe(true);
  (document.activeElement as HTMLElement).blur();
  for (const m of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) expect(s.press('ArrowRight', { [m]: true })).toBe(true);
  expect(s.play).not.toHaveBeenCalled();
  expect(s.st.time).toBe(20);
  cleanup();
  const h = setup('v.mp4', { active: false });
  expect(h.press('Space')).toBe(true);
  expect(h.play).not.toHaveBeenCalled();
});

it('the video itself focused: one toggle, and nothing else (the native handler) sees the event', () => {
  const s = setup();
  const native = vi.fn();
  s.el!.addEventListener('keydown', native); // stands in for the native controls' own handler
  s.el!.focus();
  s.press('Space', {}, s.el!);
  expect(s.play).toHaveBeenCalledTimes(1);
  expect(native).not.toHaveBeenCalled();
});

it('a held toggle key does not toggle again, a held arrow keeps seeking', () => {
  const s = setup();
  s.press('Space'); s.press('Space', { repeat: true });
  expect(s.play).toHaveBeenCalledTimes(1);
  expect(s.pause).not.toHaveBeenCalled();
  s.press('ArrowRight'); s.press('ArrowRight', { repeat: true });
  expect(s.st.time).toBe(30);
});

it('Space keyup after a handled keydown is swallowed (a focused button is not clicked)', () => {
  const s = setup();
  s.press('Space');
  expect(s.tabBtn.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true }))).toBe(false);
});

it('a flash shows the last key and fades out', async () => {
  vi.useFakeTimers();
  try {
    const s = setup();
    fireEvent(document.body, new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.querySelector('[data-player-flash]')?.textContent).toBe('+5 s');
    s.press('ArrowDown');
    await vi.waitFor(() => expect(document.querySelector('[data-player-flash]')?.textContent).toBe('\u{1F50A} 45 %'));
    vi.advanceTimersByTime(700);
    await vi.waitFor(() => expect(document.querySelector('[data-player-flash]')).toBeNull());
  } finally { vi.useRealTimers(); }
});

it('N annotates: pauses a playing video and turns the markup mode on; image tabs too; not on a server below protocol 4', () => {
  const s = setup();
  s.st.paused = false;
  expect(s.press('KeyN')).toBe(false);
  expect(s.pause).toHaveBeenCalledTimes(1);
  expect(selectDraft(s.store.getState(), s.tabId).on).toBe(true);
  cleanup();
  const img = setup('p.png');
  expect(img.press('KeyN')).toBe(false);
  expect(selectDraft(img.store.getState(), img.tabId).on).toBe(true);
  cleanup();
  const old = setup('v.mp4', { protocol: 3 });
  expect(old.press('KeyN')).toBe(true);
  expect(selectDraft(old.store.getState(), old.tabId).on).toBe(false);
});

it('while marking, the player keys are off', () => {
  const s = setup();
  act(() => void s.press('KeyN'));
  expect(s.press('Space')).toBe(true);
  expect(s.press('ArrowRight')).toBe(true);
  expect(s.press('Digit3')).toBe(false); // markup's colour key (it consumes it), not a seek
  expect(s.play).not.toHaveBeenCalled();
  expect(s.st.time).toBe(20);
});

it('scope: a text field inside our own areas still keeps its keys; a hidden pane takes none', () => {
  const s = setup();
  const input = document.createElement('input');
  s.tabBtn.parentElement!.append(input); // e.g. a filter in the tab strip
  input.focus();
  expect(s.press('Space', {}, input)).toBe(true);
  expect(s.press('ArrowRight', {}, input)).toBe(true);
  expect(s.play).not.toHaveBeenCalled();
  (document.activeElement as HTMLElement).blur();
  s.r.container.querySelector('[data-file-view]')!.setAttribute('hidden', ''); // active in the store, hidden in the DOM
  expect(s.press('Space')).toBe(true);
  expect(s.play).not.toHaveBeenCalled();
});

it('arrows seek by the chosen step: 0.1 s without float drift, the flash says so; J/L stay +-10 s', () => {
  const s = setup();
  seekStep.set(0.1);
  s.st.time = 1;
  s.press('ArrowRight'); expect(s.st.time).toBe(1.1);
  s.press('ArrowRight'); s.press('ArrowRight'); expect(s.st.time).toBe(1.3);
  s.press('ArrowLeft'); expect(s.st.time).toBe(1.2);
  s.press('KeyL'); expect(s.st.time).toBe(11.2);
  s.press('KeyJ'); expect(s.st.time).toBe(1.2);
  seekStep.set(0.5);
  s.press('ArrowRight'); expect(s.st.time).toBe(1.7);
  seekStep.set(1);
  s.press('ArrowLeft'); expect(s.st.time).toBe(0.7);
});

it('the flash text shows the step: +0.1 s, -0.5 s', async () => {
  const s = setup();
  seekStep.set(0.1);
  s.press('ArrowRight');
  await vi.waitFor(() => expect(document.querySelector('[data-player-flash]')?.textContent).toBe('+0.1 s'));
  seekStep.set(0.5);
  s.press('ArrowLeft');
  await vi.waitFor(() => expect(document.querySelector('[data-player-flash]')?.textContent).toBe('−0.5 s'));
});

it('the help line for the arrows shows the current step', () => {
  const id = PLAYER_HELP.find(([k]) => k === '← / →')![1];
  expect(t(id, 5)).toBe('−5 / +5 s (step is set on the bar)');
  expect(t(id, 0.5)).toBe('−0.5 / +0.5 s (step is set on the bar)');
  setLang('ru');
  expect(t(id, 1)).toBe('−1 / +1 с (шаг выбирается на панели)');
});
