import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaController, type PipApi } from './mediaController.ts';

/** A media element whose play/pause work in jsdom and fire the real events. */
function fake(tag: 'video' | 'audio') {
  const el = document.createElement(tag);
  let paused = true;
  let ended = false;
  Object.defineProperty(el, 'paused', { get: () => paused });
  Object.defineProperty(el, 'ended', { get: () => ended });
  el.play = vi.fn(async () => { paused = false; ended = false; el.dispatchEvent(new Event('play')); });
  el.pause = vi.fn(() => { if (paused) return; paused = true; el.dispatchEvent(new Event('pause')); });
  return Object.assign(el, { end: () => { paused = true; ended = true; el.dispatchEvent(new Event('ended')); } });
}

/** Like the browser: exit fires leavepictureinpicture on the element before resolving. */
function stubPip(o: { reject?: boolean } = {}) {
  let cur: HTMLVideoElement | null = null;
  const pip = {
    request: vi.fn(async (v: HTMLVideoElement) => {
      if (o.reject) throw new DOMException('no gesture', 'NotAllowedError');
      if (cur && cur !== v) leave();
      cur = v;
    }),
    exit: vi.fn(async () => { leave(); }),
    current: () => cur,
    /** the user pressed "back to tab" in the PiP window */
    backToTab: () => leave(),
  };
  function leave() {
    const v = cur;
    cur = null;
    v?.dispatchEvent(new Event('leavepictureinpicture'));
  }
  return pip satisfies PipApi & { backToTab(): void };
}

let pip: ReturnType<typeof stubPip>;
let activate: ReturnType<typeof vi.fn<(id: string) => void>>;
let mc: MediaController;
beforeEach(() => {
  vi.useFakeTimers();
  pip = stubPip();
  activate = vi.fn<(id: string) => void>();
  mc = new MediaController({ pip, activate });
});
afterEach(() => vi.useRealTimers());

it('media to media: the previous medium pauses, only the last may play, no PiP', async () => {
  const [a, b, c] = [fake('video'), fake('video'), fake('video')];
  mc.register('A', a); mc.register('B', b); mc.register('C', c);
  await a.play();
  mc.onSwitch('chat', 'A');
  mc.onSwitch('A', 'B');
  await b.play();
  mc.onSwitch('B', 'C');
  await c.play();
  await vi.runAllTimersAsync();
  expect(a.paused).toBe(true);
  expect(b.paused).toBe(true);
  expect(c.paused).toBe(false);
  expect(pip.request).not.toHaveBeenCalled();
  expect(mc.playing()).toBe('C');
});

it('a playing video left for the chat goes to PiP once', async () => {
  const v = fake('video');
  mc.register('V', v);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  expect(pip.request).toHaveBeenCalledTimes(1);
  expect(pip.request).toHaveBeenCalledWith(v);
  expect(v.paused).toBe(false);
});

it('a paused video left for the chat does not request PiP', async () => {
  mc.register('V', fake('video'));
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  expect(pip.request).not.toHaveBeenCalled();
});

it('video → chat (PiP) → another video: the first pauses, PiP exits, no new request', async () => {
  const [a, b] = [fake('video'), fake('video')];
  mc.register('A', a); mc.register('B', b);
  await a.play();
  mc.onSwitch('A', 'chat');
  await vi.runAllTimersAsync();
  expect(pip.current()).toBe(a);
  mc.onSwitch('chat', 'B');
  await vi.runAllTimersAsync();
  expect(a.paused).toBe(true);
  expect(pip.exit).toHaveBeenCalledTimes(1);
  expect(pip.current()).toBeNull();
  expect(pip.request).toHaveBeenCalledTimes(1); // only the first one
  expect(activate).not.toHaveBeenCalled();
});

it('our own exit produces no activate', async () => {
  const v = fake('video');
  mc.register('V', v);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  mc.onSwitch('chat', 'V'); // back to its own tab: we close the PiP window ourselves
  await vi.runAllTimersAsync();
  expect(pip.exit).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
  expect(v.paused).toBe(false); // keeps playing in its pane
});

it('closing a tab with its video in PiP exits PiP without activate', async () => {
  const v = fake('video');
  mc.register('V', v);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  mc.onClose('V');
  await vi.runAllTimersAsync();
  expect(v.paused).toBe(true);
  expect(pip.exit).toHaveBeenCalledTimes(1);
  expect(activate).not.toHaveBeenCalled();
});

it("the user's back to tab activates the video's tab once, and starts nothing", async () => {
  const [v, other] = [fake('video'), fake('video')];
  mc.register('V', v); mc.register('O', other);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  pip.backToTab();
  await vi.runAllTimersAsync();
  expect(activate).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith('V');
  expect(pip.request).toHaveBeenCalledTimes(1);
  expect(v.play).toHaveBeenCalledTimes(1); // only our own play() above
  expect(other.play).not.toHaveBeenCalled();
});

it('closing the PiP window (the browser pauses the video) does not switch tabs', async () => {
  const v = fake('video');
  mc.register('V', v);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  pip.backToTab();
  v.pause(); // Chrome pauses on the window's ×, right after leavepictureinpicture
  await vi.runAllTimersAsync();
  expect(activate).not.toHaveBeenCalled();
});

it('an ended video leaving PiP does not switch tabs', async () => {
  const v = fake('video');
  mc.register('V', v);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  v.end();
  pip.backToTab();
  await vi.runAllTimersAsync();
  expect(activate).not.toHaveBeenCalled();
});

it('audio keeps playing when its tab is left for the chat', async () => {
  const a = fake('audio');
  mc.register('A', a);
  await a.play();
  mc.onSwitch('A', 'chat');
  await vi.runAllTimersAsync();
  expect(a.paused).toBe(false);
  expect(pip.request).not.toHaveBeenCalled();
  expect(mc.playing()).toBe('A');
});

it('closing a tab pauses its medium', async () => {
  const a = fake('audio');
  mc.register('A', a);
  await a.play();
  mc.onClose('A');
  expect(a.paused).toBe(true);
  expect(pip.exit).not.toHaveBeenCalled();
  expect(mc.playing()).toBeNull();
});

it('a rejected PiP request leaves the video playing hidden', async () => {
  pip = stubPip({ reject: true });
  mc = new MediaController({ pip, activate });
  const v = fake('video');
  mc.register('V', v);
  await v.play();
  mc.onSwitch('V', 'chat');
  await vi.runAllTimersAsync();
  expect(pip.request).toHaveBeenCalledTimes(1);
  expect(v.paused).toBe(false);
});

it('switching to a media tab that is not registered yet still pauses the previous medium (isMedia)', async () => {
  mc = new MediaController({ pip, activate, isMedia: (id) => id.endsWith('.mp4') });
  const a = fake('video');
  mc.register('a.mp4', a);
  await a.play();
  mc.onSwitch('a.mp4', 'b.mp4'); // b's element mounts after the switch
  await vi.runAllTimersAsync();
  expect(a.paused).toBe(true);
  expect(pip.request).not.toHaveBeenCalled();
});

it('subscribers hear play, pause and ended; unregister stops tracking', async () => {
  const v = fake('video');
  const off = mc.register('V', v);
  const seen = vi.fn();
  const unsub = mc.subscribe(seen);
  await v.play();
  v.pause();
  await v.play();
  v.end();
  expect(seen).toHaveBeenCalledTimes(4);
  await v.play();
  off();
  expect(mc.playing()).toBeNull();
  unsub();
  v.pause();
  expect(seen).toHaveBeenCalledTimes(6); // play + the unregister itself, nothing after unsubscribe
});
