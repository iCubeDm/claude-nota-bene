export type PipApi = { request(v: HTMLVideoElement): Promise<void>; exit(): Promise<void>; current(): Element | null };

/** The browser's Picture-in-Picture API, as a PipApi. */
export const browserPip: PipApi = {
  request: (v) => {
    if (!document.pictureInPictureEnabled || v.disablePictureInPicture) return Promise.reject(new Error('PiP unavailable'));
    return v.requestPictureInPicture().then(() => undefined);
  },
  exit: () => (document.pictureInPictureElement ? document.exitPictureInPicture() : Promise.resolve()),
  current: () => document.pictureInPictureElement ?? null,
};

/** How long after a user's leavepictureinpicture we look at the video: Chrome pauses it right after the event when the window's × is used. */
const BACK_TO_TAB_DELAY = 50;

/**
 * Pause and picture-in-picture rules for media tabs (spec → Follow-ups → Media and picture-in-picture loop):
 * - switching to a media tab pauses every other medium and closes PiP: only one thing plays, PiP never hops between tabs
 *   (hopping is what made three videos select each other in an endless loop in the prototype);
 * - leaving a playing video for a non-media tab sends it to PiP (one window); audio keeps playing;
 * - PiP's "back to tab" only activates the video's tab; our own exit() is ignored;
 * - closing a tab pauses its medium and closes PiP if it is the one.
 * Lives outside React and Redux: it holds DOM elements.
 */
export class MediaController {
  private els = new Map<string, HTMLMediaElement>();
  private ownExit = new Set<Element>(); // elements whose next leavepictureinpicture we caused
  private subs = new Set<() => void>();
  private readonly pip: PipApi;
  private readonly activate: (tabId: string) => void;
  private readonly isMedia: (tabId: string) => boolean;

  constructor(o: { pip: PipApi; activate: (tabId: string) => void; isMedia?: (tabId: string) => boolean }) {
    this.pip = o.pip;
    this.activate = o.activate;
    // a tab opened right now has no element yet, so the caller may know better than the registry
    this.isMedia = o.isMedia ?? ((id) => this.els.has(id));
  }

  register(tabId: string, el: HTMLMediaElement): () => void {
    const notify = () => this.notify();
    const onLeave = () => this.onLeavePip(tabId, el);
    const evs = ['play', 'pause', 'ended', 'emptied'] as const;
    for (const ev of evs) el.addEventListener(ev, notify);
    el.addEventListener('leavepictureinpicture', onLeave);
    this.els.set(tabId, el);
    this.notify();
    return () => {
      for (const ev of evs) el.removeEventListener(ev, notify);
      el.removeEventListener('leavepictureinpicture', onLeave);
      this.ownExit.delete(el);
      if (this.els.get(tabId) === el) this.els.delete(tabId);
      this.notify();
    };
  }

  /** Call before `to` is shown. */
  onSwitch(from: string, to: string): void {
    if (from === to) return;
    if (this.isMedia(to)) {
      const target = this.els.get(to);
      for (const el of this.els.values()) if (el !== target && !el.paused) el.pause();
      if (this.pip.current()) this.exitPip(); // another tab's video (paused above), or `to`'s own: it plays on in its pane
      return;
    }
    const el = this.els.get(from);
    if (!(el instanceof HTMLVideoElement) || el.paused || el.ended || this.pip.current() === el) return; // audio plays on
    // a rejected request (no user activation, PiP disabled, headless) leaves the video playing hidden, as before PiP
    const request = () => this.pip.request(el).catch(() => {});
    // one PiP window: close another first; otherwise request synchronously, before the pane is hidden
    if (this.pip.current()) void this.exitPip().then(request);
    else void request();
  }

  /** Pause the tab's medium and close PiP if it is this one. */
  onClose(tabId: string): void {
    const el = this.els.get(tabId);
    if (!el) return;
    if (this.pip.current() === el) this.exitPip();
    if (!el.paused) el.pause();
  }

  /** Tab id of the playing medium, for the ▶ dot. */
  playing(): string | null {
    for (const [id, el] of this.els) if (!el.paused && !el.ended) return id;
    return null;
  }

  /** Called on play, pause, ended and (un)registration; for useSyncExternalStore. */
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  private notify() {
    for (const fn of this.subs) fn();
  }

  private exitPip(): Promise<void> {
    const cur = this.pip.current();
    if (cur) this.ownExit.add(cur);
    return this.pip.exit().catch(() => {
      if (cur) this.ownExit.delete(cur); // no event will come
    });
  }

  private onLeavePip(tabId: string, el: HTMLMediaElement) {
    if (this.ownExit.delete(el)) return; // we closed it: no tab switch
    // the user left PiP: "back to tab" keeps it playing → show its tab; the window's × pauses it → nothing
    setTimeout(() => {
      if (this.els.get(tabId) === el && !el.paused && !el.ended) this.activate(tabId);
    }, BACK_TO_TAB_DELAY);
  }
}

/** Pauses `el` and seeks it to `t` s; before its metadata is loaded a seek would be lost, so it waits for that. */
export function seekAndPause(el: HTMLMediaElement, t: number): void {
  el.pause();
  const go = () => void (el.currentTime = t);
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA) go();
  else el.addEventListener('loadedmetadata', go, { once: true });
}
