import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { MediaShape } from '@nota-bene/shared';
import { contentBox, shapePath } from './geometry.ts';

/** What the overlays over a media tab share: the drawing (MarkupLayer) and the marks of its comments (MediaMarks). */

export type Media = HTMLImageElement | HTMLVideoElement;

export const STROKE_PX = 3;
/** A dark outline under every stroke, so a white or yellow mark stays visible on a light frame (no CSS filter: cheap). */
export const HALO_PX = STROKE_PX + 2;
export const HALO = 'rgba(0,0,0,0.55)';

export const natSize = (m: Media): [number, number] =>
  m instanceof HTMLVideoElement ? [m.videoWidth, m.videoHeight] : [m.naturalWidth, m.naturalHeight];

/** The media's natural size, followed as it arrives (image load, video metadata), whether or not an overlay is shown. */
export function useNatSize(media: Media): [[number, number], () => void] {
  const [nat, setNat] = useState<[number, number]>(() => natSize(media));
  const syncNat = useCallback(() => setNat((old) => {
    const [w, h] = natSize(media);
    return old[0] === w && old[1] === h ? old : [w, h];
  }), [media]);
  useEffect(() => {
    syncNat();
    media.addEventListener('load', syncNat);
    media.addEventListener('loadedmetadata', syncNat);
    return () => {
      media.removeEventListener('load', syncNat);
      media.removeEventListener('loadedmetadata', syncNat);
    };
  }, [media, syncNat]);
  return [nat, syncNat];
}

/**
 * Keeps `svg` over the media's content box while `on`. The svg is a child of the pane (the media's scroll container),
 * so it scrolls with the media natively, with no per-frame JS; its box follows resizes, the fit/natural toggle, the
 * media's load and the pane being unhidden (a ResizeObserver). Coordinates come from `contentBox` of the media
 * element's own rect (it has no border or padding), so neither the zoom, the scroll nor the device pixel ratio enters.
 * `after(content, element)`: called with both client rects after each placement (MediaMarks clips its hit area there).
 * Returns `box()`: the content box now, in client px.
 */
export function useOverlayPlacement(
  svg: RefObject<SVGSVGElement | null>, media: Media, fit: 'contain' | 'natural', on: boolean,
  after?: (content: DOMRect, element: DOMRect) => void,
): () => DOMRect {
  const pane = media.parentElement;
  const afterRef = useRef(after);
  afterRef.current = after;
  const box = useCallback(() => {
    const [w, h] = natSize(media);
    return contentBox(media.getBoundingClientRect(), w, h, fit);
  }, [media, fit]);
  const place = useCallback(() => {
    const el = svg.current;
    if (!el || !pane) return;
    const r = media.getBoundingClientRect();
    const [w, h] = natSize(media);
    const b = contentBox(r, w, h, fit);
    const p = pane.getBoundingClientRect();
    el.style.left = `${b.x - p.x - pane.clientLeft + pane.scrollLeft}px`;
    el.style.top = `${b.y - p.y - pane.clientTop + pane.scrollTop}px`;
    el.style.width = `${b.width}px`;
    el.style.height = `${b.height}px`;
    afterRef.current?.(b, r);
  }, [svg, media, fit, pane]);
  useLayoutEffect(() => {
    if (!on) return;
    place();
    media.addEventListener('load', place);
    media.addEventListener('loadedmetadata', place);
    window.addEventListener('resize', place);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(media);
    if (pane) ro?.observe(pane);
    return () => {
      media.removeEventListener('load', place);
      media.removeEventListener('loadedmetadata', place);
      window.removeEventListener('resize', place);
      ro?.disconnect();
    };
  }, [on, media, pane, place]);
  return box;
}

/** A shape as two paths in a 0..1 viewBox: the dark halo, then the shape in its own colour (non-scaling strokes). */
export function shapeEls(shapes: MediaShape[], natW: number, natH: number) {
  return shapes.flatMap((s, i) => {
    const d = shapePath(s, natW, natH);
    return [
      <path key={`h${i}`} data-halo d={d} stroke={HALO} strokeWidth={HALO_PX} vectorEffect="non-scaling-stroke" />,
      <path key={i} data-shape={s.kind} d={d} stroke={s.color} vectorEffect="non-scaling-stroke" />,
    ];
  });
}
