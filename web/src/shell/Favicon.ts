import { useEffect } from 'react';
import type { Store } from '@reduxjs/toolkit';
import { useStore } from 'react-redux';
import type { RootState } from '@/store/store.ts';

// Prototype values (prototype/public/index.html), verbatim.
export const FAV = { idle: '#8b6cf2', work: '#8b6cf2', workHi: '#f0761f', wait: '#e5484d', done: '#22b45a' } as const;
export type FavState = 'idle' | 'work' | 'wait' | 'done';
const BLINK_MS = 700;

export const faviconSvg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15.5" fill="${fill}"/>` +
  '<g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M7.5 21.5v-11l6.5 11v-11"/><path d="M18 10.5h3.2a2.75 2.75 0 0 1 0 5.5H18z"/><path d="M18 16h3.7a2.75 2.75 0 0 1 0 5.5H18z"/></g></svg>';

/** wait > work > done > idle */
export function favState(s: RootState, done: boolean): FavState {
  if (s.feed.items.some((it) => it.kind === 'permission' && it.answer === undefined)) return 'wait';
  if (s.feed.busy) return 'work';
  return done ? 'done' : 'idle';
}

function link(doc: Document): HTMLLinkElement {
  let l = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!l) {
    l = doc.createElement('link');
    l.rel = 'icon';
    doc.head.appendChild(l);
  }
  l.type = 'image/svg+xml';
  return l;
}

/** Subscribes to the store and keeps `link[rel=icon]` in step; redraws only on a state change (and on each blink tick). */
export function startFavicon(store: Pick<Store<RootState>, 'getState' | 'subscribe'>, doc: Document = document, win: Window = window): () => void {
  const el = link(doc);
  const draw = (fill: string) => { el.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(fill))}`; };
  const away = () => doc.hidden || !doc.hasFocus();
  let done = false;
  let seen = store.getState().feed.turnSeq;
  let cur: FavState | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopBlink = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
  const sync = () => {
    const next = favState(store.getState(), done);
    if (next === cur) return;
    cur = next;
    stopBlink();
    if (next === 'work') {
      let hi = true;
      draw(FAV.workHi);
      timer = setInterval(() => { hi = !hi; draw(hi ? FAV.workHi : FAV.work); }, BLINK_MS);
    } else draw(FAV[next]);
  };
  const unsub = store.subscribe(() => {
    const seq = store.getState().feed.turnSeq;
    // a live result only: a replay keeps turnSeq, so reconnecting never lights "done"
    if (seq !== seen) { seen = seq; if (away()) done = true; }
    sync();
  });
  const seenIt = () => { if (done && !away()) { done = false; sync(); } };
  win.addEventListener('focus', seenIt);
  doc.addEventListener('visibilitychange', seenIt);
  sync();
  return () => {
    unsub();
    stopBlink();
    win.removeEventListener('focus', seenIt);
    doc.removeEventListener('visibilitychange', seenIt);
  };
}

export function useFavicon(): void {
  const store = useStore<RootState>();
  useEffect(() => startFavicon(store), [store]);
}
