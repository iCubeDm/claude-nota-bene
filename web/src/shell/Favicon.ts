import { useEffect } from 'react';
import type { Store } from '@reduxjs/toolkit';
import { useStore } from 'react-redux';
import type { RootState } from '@/store/store.ts';

/**
 * One colour per meaning (user, 2026-10-27): working blinks between two oranges (the ⚙ indicator's), a question for the
 * user (a permission, a plan to approve) is blue, done is green, an error (a failed turn, a dropped connection) is red;
 * idle is a quiet grey that asks for nothing.
 */
export const FAV = { idle: '#6b7280', work: '#f7b267', workHi: '#f0761f', ask: '#0a84ff', done: '#22b45a', error: '#e5484d' } as const;
export type FavState = 'idle' | 'work' | 'ask' | 'done' | 'error';
/** How a live turn ended while the tab was not looked at (null: nothing to announce). */
export type Unseen = 'done' | 'error' | null;
const BLINK_MS = 700;

export const faviconSvg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15.5" fill="${fill}"/>` +
  '<g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M7.5 21.5v-11l6.5 11v-11"/><path d="M18 10.5h3.2a2.75 2.75 0 0 1 0 5.5H18z"/><path d="M18 16h3.7a2.75 2.75 0 0 1 0 5.5H18z"/></g></svg>';

/**
 * dropped connection > question > work > an unseen outcome (done / error) > idle. A live background task (subagent,
 * shell) is work too, after the turn that started it ends.
 */
export function favState(s: RootState, unseen: Unseen): FavState {
  // an occupied / taken tab is not broken, it is parked: quiet grey, never the red of a dropped connection
  if (s.conn.state === 'occupied' || s.conn.state === 'taken') return 'idle';
  if (s.conn.state === 'closed') return 'error';
  if (s.feed.items.some((it) => it.kind === 'permission' && it.answer === undefined)) return 'ask';
  if (s.feed.busy || Object.keys(s.tasks).length > 0) return 'work';
  return unseen ?? 'idle';
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
  let unseen: Unseen = null;
  let seen = store.getState().feed.turnSeq;
  let cur: FavState | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopBlink = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
  const sync = () => {
    const next = favState(store.getState(), unseen);
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
    const { turnSeq: seq, items } = store.getState().feed;
    // a live result only: a replay keeps turnSeq, so reconnecting never lights "done"
    if (seq !== seen) {
      seen = seq;
      if (away()) {
        const last = items.findLast((it) => it.kind === 'done');
        unseen = last?.kind === 'done' && last.status === 'failed' ? 'error' : 'done';
      }
    }
    sync();
  });
  const seenIt = () => { if (unseen && !away()) { unseen = null; sync(); } };
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
