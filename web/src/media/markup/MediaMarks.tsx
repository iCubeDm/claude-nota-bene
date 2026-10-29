import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { openCommentCard, selectMediaComments, type MediaComment } from '@/comments/slice.ts';
import { selectFileVersion } from '@/files/slice.ts';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { shapePath } from './geometry.ts';
import { aspectScale } from '@/model/pose.ts';
import { shapeEls, STROKE_PX, useNatSize, useOverlayPlacement, type Media } from './overlay.tsx';
import { selectDraft } from './slice.ts';

/**
 * How near the paused time must be to a video mark's time: half a frame, or 40 ms when the rate is unknown. A browser
 * never tells a video's frame rate, and half a frame is under 40 ms for any rate above 12.5 fps, so
 * `max(0.5 / fps, 0.04)` is 0.04 in practice.
 */
export const TIME_TOLERANCE = 0.04;
const SENT_OPACITY = 0.35;
/** A stroke is thin: the click target is a wider invisible stroke along it (the shapes' insides stay click-through). */
const HIT_PX = 12;

/** The comment was drawn on another version of the file than the one known now (false when either is unknown). */
export const changedSince = (c: MediaComment, current: string | undefined): boolean =>
  !!c.anchor.version && current !== undefined && current !== c.anchor.version;

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
 * ones dimmed (and not drawn at all once the file has changed since). A video shows a comment's marks only while paused at its time (never over moving frames). While
 * the markup mode is on in this tab they stay drawn (the mode stays on after an Add, so the comments made so far stay
 * in view) but take no clicks: the pointer belongs to the drawing then.
 *
 * Clicks: the svg takes no pointer events; only an invisible wider stroke along each shape does (a click opens the
 * comment's card), so the media's own clicks (the image's zoom, the video's play) pass through a shape's inside. The
 * player bar (PlayerBar) is a later sibling above this layer, so over it the bar wins.
 *
 * Lag: the paths of a comment are built once per comment object; the overlay scrolls with the pane natively and is
 * placed only on resizes. With no mark to show, nothing is mounted or observed.
 */
/** `refName`: the file's ref for another source (not `ref`: that name is React's). */
export function MediaMarks({ tabId, media, fit, path, refName: ref, atView }: {
  tabId: string; media: Media; fit: 'contain' | 'natural'; path: string; refName?: string;
  /** a 3D view (canvas): the ids of the comments whose camera the view is at now; only those show (like a video mark at its time) */
  atView?: ReadonlySet<string>;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const all = useAppSelector((s) => selectMediaComments(s, path, ref));
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  const current = useAppSelector((s) => selectFileVersion(s, path, ref));
  const at = usePausedAt(media);
  const [nat] = useNatSize(media); // a canvas: followed as its box changes
  const video = media instanceof HTMLVideoElement;
  const shown = useMemo(() => {
    if (at === null) return [];
    // a sent mark drawn on another version of the file points at what is no longer there (a pending one stays, flagged)
    const live = all.filter((c) => !(c.status === 'sent' && changedSince(c, current)));
    const list = video ? live.filter((c) => c.anchor.time !== undefined && Math.abs(c.anchor.time - at) <= TIME_TOLERANCE)
      : media instanceof HTMLCanvasElement ? live.filter((c) => atView?.has(c.id)) : live;
    return list.some((c) => c.status === 'sent') ? [...list].sort((a, b) => (a.status === b.status ? 0 : a.status === 'sent' ? -1 : 1)) : list;
  }, [all, at, video, media, atView, current]);

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
  const pane = media.parentElement;
  const on = shown.length > 0 && !!pane;
  useOverlayPlacement(svg, media, fit, on);

  // a 3D view: the marks were drawn on the aspect the canvas had then; the camera's fov is vertical, so only x moves
  const fix = (c: MediaComment): string | undefined => {
    if (!(media instanceof HTMLCanvasElement)) return undefined;
    const k = aspectScale(c.anchor.width, c.anchor.height, nat[0], nat[1]);
    return k === 1 ? undefined : `translate(0.5 0) scale(${k} 1) translate(-0.5 0)`;
  };
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
      {shown.map((c) => (
        <g key={c.id} data-mark={c.id} transform={fix(c)} opacity={c.status === 'sent' ? SENT_OPACITY : undefined}>{drawn(c).els}</g>
      ))}
      {!marking && shown.map((c) => {
        const changed = changedSince(c, current);
        return (
          <g key={c.id} data-hit={c.id} transform={fix(c)} onClick={open(c.id)} className="cursor-pointer">
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
