import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { keysInScope } from '@/lib/keyScope.ts';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector, type AppDispatch } from '@/store/store.ts';
import { setMode } from './markup/slice.ts';

/** YouTube's keys for a media tab (see docs: player keys). `code`, not `key`: any keyboard layout. */

export const FRAME = 1 / 30; // the frame rate is not exposed by the element; 30 fps is the usual

const MINUS = '−';
const sec = (n: number, unit: string) => `${n < 0 ? MINUS : '+'}${Math.abs(n)} ${unit}`;

/** Where focus may sit for the keys to stay ours: the tab's own file view, the tab strip, the file tree. */
const OURS = '[data-file-view], [role="tablist"], #tree-sheet';
const THEIRS = '[role="dialog"], [role="menu"], [role="listbox"], [data-nb-modal]';
export const inPlayerScope = (f: Element): boolean => !f.closest(THEIRS) && !!f.closest(OURS);

/** The one-per-press keys: a held key must not toggle again and again. */
const ONCE = (c: string) => !/^(Arrow|Comma|Period|Key[JL])/.test(c);

/**
 * Applies `code` to `el`; returns the on-screen flash text, or null when the key does not apply here (then the event
 * stays untouched: no preventDefault). `video`: frame step and fullscreen exist only for it. Fullscreen takes `box`, the
 * player container (video, marks, bar), so the marks and the bar stay visible; the element itself without one.
 */
export function applyPlayerKey(el: HTMLMediaElement, code: string, unit: string, box?: HTMLElement | null): string | null {
  const video = el instanceof HTMLVideoElement;
  const dur = Number.isFinite(el.duration) ? el.duration : Infinity;
  const seek = (to: number) => void (el.currentTime = Math.max(0, Math.min(dur, to)));
  const by = (d: number) => (seek(el.currentTime + d), sec(d, unit));
  const vol = (d: number) => {
    if (d > 0 && el.muted) el.muted = false;
    el.volume = Math.max(0, Math.min(1, Math.round((el.volume + d) * 100) / 100));
    return `\u{1F50A} ${Math.round(el.volume * 100)} %`;
  };
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  switch (code) {
    case 'Space': case 'KeyK':
      if (el.paused) { void el.play()?.catch(() => {}); return '▶'; }
      el.pause();
      return '❚❚';
    case 'ArrowLeft': return by(-5);
    case 'ArrowRight': return by(5);
    case 'KeyJ': return by(-10);
    case 'KeyL': return by(10);
    case 'ArrowUp': return vol(0.05);
    case 'ArrowDown': return vol(-0.05);
    case 'KeyM': el.muted = !el.muted; return el.muted ? '\u{1F507}' : `\u{1F50A} ${Math.round(el.volume * 100)} %`;
    case 'KeyF':
      if (!video) return null;
      if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => {});
      else void (box ?? el).requestFullscreen?.()?.catch(() => {});
      return '⛶';
    case 'Comma': case 'Period':
      if (!video || !el.paused) return null;
      seek(el.currentTime + (code === 'Comma' ? -FRAME : FRAME));
      return code === 'Comma' ? '◀▏' : '▕▶';
    case 'Home': seek(0); return '0 %';
    case 'End': if (!Number.isFinite(dur)) return null; seek(dur); return '100 %';
  }
  if (digit) {
    if (!Number.isFinite(dur)) return null;
    seek((dur * Number(digit[1])) / 10);
    return `${Number(digit[1]) * 10} %`;
  }
  return null;
}

export type Flash = { n: number; text: string };

/** N and the bar's ✎: one still frame, then the markup mode. */
export function startAnnotate(dispatch: AppDispatch, tabId: string, m: HTMLVideoElement | HTMLImageElement): void {
  if (m instanceof HTMLVideoElement && !m.paused) m.pause();
  dispatch(setMode(tabId, true));
}

/**
 * The visible media tab's player keys, plus N = annotate. Off while marking up (the markup mode owns the keys then).
 * Capture phase and preventDefault+stopPropagation: a focused <video> must not also act on its own, and Space neither
 * scrolls nor presses a focused button (its keyup is swallowed too, Firefox clicks on it).
 * `image`: the element N annotates; `media`: the video/audio the rest acts on (null for an image tab).
 */
export function usePlayerKeys({ tabId, active, marking, media, image, box }: {
  tabId: string; active: boolean; marking: boolean; media: MutableRefObject<HTMLMediaElement | null>; image: HTMLImageElement | null;
  box?: MutableRefObject<HTMLElement | null>;
}): Flash | null {
  const t = useT();
  const dispatch = useAppDispatch();
  const offered = useAppSelector((s) => s.controls.protocol >= 4);
  const [flash, setFlash] = useState<Flash | null>(null);
  const n = useRef(0);
  const unit = t('unitSec');
  useEffect(() => {
    if (!active || marking) return;
    let swallowKeyup = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const code = e.code.replace(/^Numpad(\d)$/, 'Digit$1');
      const el = media.current ?? image;
      if (!el || !keysInScope(e, el, inPlayerScope)) return;
      if (code === 'KeyN') {
        const m = media.current ?? image;
        if (!offered || !(m instanceof HTMLVideoElement || m instanceof HTMLImageElement)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        startAnnotate(dispatch, tabId, m);
        return;
      }
      if (!media.current) return;
      const text = e.repeat && ONCE(code) ? '' : applyPlayerKey(media.current, code, unit, box?.current);
      if (text === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (code === 'Space') swallowKeyup = true;
      if (text) setFlash({ n: ++n.current, text });
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && swallowKeyup) { swallowKeyup = false; e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onUp, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onUp, true);
    };
  }, [active, marking, media, image, box, offered, dispatch, tabId, unit]);
  return flash;
}

/** The player's help rows: [keys, i18n id], shown as one group in the hotkey tooltip. */
export const PLAYER_HELP = [
  ['Space, K', 'pk_toggle'], ['← / →', 'pk_seek5'], ['J / L', 'pk_seek10'], ['↑ / ↓', 'pk_volume'], ['M', 'pk_mute'],
  ['F', 'pk_fullscreen'], ['0…9', 'pk_percent'], [', / .', 'pk_frame'], ['Home / End', 'pk_ends'], ['N', 'pk_annotate'],
] as const;
