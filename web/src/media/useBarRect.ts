import { useLayoutEffect, useState, type MutableRefObject } from 'react';
import { contentBox } from './markup/geometry.ts';
import { natSize, type Media } from './markup/overlay.tsx';

/** The narrowest the bar gets: a narrower picture gets a bar this wide, centred on it, so the buttons fit. */
export const BAR_MIN_PX = 360;

export type BarRect = { left: number; width: number; bottom: number };

/**
 * Where a video's bar goes in `box` (its positioned container): over the bottom edge of the video's rendered picture
 * (the same `contentBox` the marks overlay uses), as wide as the picture but not under BAR_MIN_PX, centred on it and
 * kept inside `box`. Follows the media's load, window resize, ResizeObserver on media and box, a scroll of the media's
 * pane, and fullscreen changes. null until measured (or without a box).
 */
export function useBarRect(media: Media, box: MutableRefObject<HTMLElement | null>, on: boolean): BarRect | null {
  const [rect, setRect] = useState<BarRect | null>(null);
  useLayoutEffect(() => {
    const host = box.current;
    if (!on || !host) { setRect(null); return; }
    const pane = media.parentElement;
    const place = () => {
      const [w, h] = natSize(media);
      const b = contentBox(media.getBoundingClientRect(), w, h, 'contain');
      const p = host.getBoundingClientRect();
      const width = Math.min(Math.max(b.width, BAR_MIN_PX), p.width || Infinity);
      const left = Math.max(0, Math.min(b.x - p.x - host.clientLeft + (b.width - width) / 2, (p.width || Infinity) - width));
      const bottom = p.bottom - b.bottom;
      setRect((old) => old && old.left === left && old.width === width && old.bottom === bottom ? old : { left, width, bottom });
    };
    place();
    media.addEventListener('loadedmetadata', place);
    window.addEventListener('resize', place);
    document.addEventListener('fullscreenchange', place);
    pane?.addEventListener('scroll', place);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(media);
    ro?.observe(host);
    return () => {
      media.removeEventListener('loadedmetadata', place);
      window.removeEventListener('resize', place);
      document.removeEventListener('fullscreenchange', place);
      pane?.removeEventListener('scroll', place);
      ro?.disconnect();
    };
  }, [media, box, on]);
  return rect;
}
