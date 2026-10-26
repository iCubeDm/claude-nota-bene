import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { openCommentCard, selectMediaComments, type MediaComment } from '@/comments/slice.ts';
import { selectFileVersion } from '@/files/slice.ts';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { shapePath } from './geometry.ts';
import { shapeEls, STROKE_PX, useOverlayPlacement, type Media } from './overlay.tsx';
import { selectDraft } from './slice.ts';

/**
 * How near the paused time must be to a video mark's time: half a frame, or 40 ms when the rate is unknown. A browser
 * never tells a video's frame rate, and half a frame is under 40 ms for any rate above 12.5 fps, so
 * `max(0.5 / fps, 0.04)` is 0.04 in practice.
 */
export const TIME_TOLERANCE = 0.04;
/** The native controls' strip at the bottom of a video element: the hit area never reaches into it. */
export const CONTROLS_PX = 48;
const SENT_OPACITY = 0.35;
/** A stroke is thin: the click target is a wider invisible stroke along it (the shapes' insides stay click-through). */
const HIT_PX = 12;

/** The video's time while paused, null while it plays; an image: always 0 (every mark shows). */
function usePausedAt(media: Media): number | null {
  const read = useCallback(() => (media instanceof HTMLVideoElement ? (media.paused ? media.currentTime : null) : 0), [media]);
  const [at, setAt] = useState(read);
  useEffect(() => {
    setAt(read());
    if (!(media instanceof HTMLVideoElement)) return;
    const sync = () => setAt(read()); // same value while playing (timeupdate ~4 Hz): no re-render
    const evs = ['play', 'playing', 'pause', 'seeked', 'timeupdate', 'loadedmetadata', 'emptied'] as const;
    for (const ev of evs) media.addEventListener(ev, sync);
    return () => { for (const ev of evs) media.removeEventListener(ev, sync); };
  }, [media, read]);
  return at;
}

/**
 * The marks of a media tab's comments, over its content box: each shape in its own colour with the dark halo, sent
 * ones dimmed. A video shows a comment's marks only while paused at its time (never over moving frames). Hidden while
 * the markup mode is on in this tab (the draft is what is seen then).
 *
 * Clicks: the svg takes no pointer events; only an invisible wider stroke along each shape does (a click opens the
 * comment's card), so the media's own clicks (the image's zoom, the video's play) pass through a shape's inside. Over a
 * video the hit strokes are clipped out of the bottom CONTROLS_PX of the element, where its native controls are.
 *
 * Lag: the paths of a comment are built once per comment object; the overlay scrolls with the pane natively and is
 * placed only on resizes. With no mark to show, nothing is mounted or observed.
 */
/** `refName`: the file's ref for another source (not `ref`: that name is React's). */
export function MediaMarks({ tabId, media, fit, path, refName: ref }: {
  tabId: string; media: Media; fit: 'contain' | 'natural'; path: string; refName?: string;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const all = useAppSelector((s) => selectMediaComments(s, path, ref));
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  const current = useAppSelector((s) => selectFileVersion(s, path, ref));
  const at = usePausedAt(media);
  const video = media instanceof HTMLVideoElement;
  const shown = useMemo(() => {
    if (marking || at === null) return [];
    const list = video ? all.filter((c) => c.anchor.time !== undefined && Math.abs(c.anchor.time - at) <= TIME_TOLERANCE) : all;
    return list.some((c) => c.status === 'sent') ? [...list].sort((a, b) => (a.status === b.status ? 0 : a.status === 'sent' ? -1 : 1)) : list;
  }, [all, at, marking, video]);

  // the paths of a comment, per comment object (an edit of the text makes a new object; that is rare and cheap)
  const cache = useRef(new WeakMap<MediaComment, { els: ReturnType<typeof shapeEls>; ds: string[] }>());
  const drawn = (c: MediaComment) => {
    let hit = cache.current.get(c);
    if (!hit) {
      const { width: w, height: h, shapes } = c.anchor;
      hit = { els: shapeEls(shapes, w, h), ds: shapes.map((s) => shapePath(s, w, h)) };
      cache.current.set(c, hit);
    }
    return hit;
  };

  const svg = useRef<SVGSVGElement>(null);
  const clipRect = useRef<SVGRectElement>(null);
  const clipId = `nb-marks-clip-${useId().replace(/:/g, '')}`;
  // the hit area ends CONTROLS_PX above the element's bottom: in viewBox units of the content box's height
  const clip = useCallback((b: DOMRect, el: DOMRect) => {
    const free = video ? Math.max(0, CONTROLS_PX - (el.bottom - b.bottom)) : 0;
    const h = b.height > 0 ? Math.max(0, 1 - free / b.height) : 1;
    // from y = -1 (a stroke along the top edge sticks out above it) down to h
    clipRect.current?.setAttribute('height', String(Math.round((1 + h) * 10000) / 10000));
  }, [video]);
  const pane = media.parentElement;
  const on = shown.length > 0 && !!pane;
  useOverlayPlacement(svg, media, fit, on, clip);

  const open = (id: string) => (e: MouseEvent) => {
    e.stopPropagation();
    dispatch(openCommentCard({ id, x: e.clientX, y: e.clientY }));
  };

  if (!on) return null;
  return createPortal(
    <svg
      ref={svg}
      data-media-marks
      data-anchor-skip
      aria-hidden="true"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      fill="none"
      strokeWidth={STROKE_PX}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute z-10 overflow-visible select-none"
    >
      <defs>
        <clipPath id={clipId}>
          <rect ref={clipRect} x="-1" y="-1" width="3" height="2" />
        </clipPath>
      </defs>
      {shown.map((c) => (
        <g key={c.id} data-mark={c.id} opacity={c.status === 'sent' ? SENT_OPACITY : undefined}>{drawn(c).els}</g>
      ))}
      {shown.map((c) => {
        const changed = !!c.anchor.version && current !== undefined && current !== c.anchor.version;
        return (
          <g key={c.id} data-hit={c.id} clipPath={`url(#${clipId})`} onClick={open(c.id)} className="cursor-pointer">
            {changed && <title>{t('fileChanged')}</title>}
            {drawn(c).ds.map((d, i) => (
              <path key={i} d={d} stroke="transparent" strokeWidth={HIT_PX} vectorEffect="non-scaling-stroke" pointerEvents="stroke" />
            ))}
          </g>
        );
      })}
    </svg>,
    pane,
  );
}
