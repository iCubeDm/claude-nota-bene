import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { MARK_COLORS, PEN_MAX_VALUES, type MediaShape } from '@nota-bene/shared';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { contentBox, rectFrom, shapePath, simplify, toRel } from './geometry.ts';
import { MarkupToolbar } from './MarkupToolbar.tsx';
import { addShape, clear, selectDraft, setColor, setMode, setTool, undo, type MarkTool } from './slice.ts';

type Media = HTMLImageElement | HTMLVideoElement;
type Pt = { x: number; y: number };

/** The native video controls' strip at the bottom of the frame: the layer never takes a press that starts there. */
const VIDEO_CONTROLS_PX = 44;
const STROKE_PX = 3;
const TOOL_KEYS: Record<string, MarkTool> = { KeyR: 'rect', KeyE: 'ellipse', KeyP: 'pen', KeyA: 'arrow' };

const natSize = (m: Media): [number, number] =>
  m instanceof HTMLVideoElement ? [m.videoWidth, m.videoHeight] : [m.naturalWidth, m.naturalHeight];
const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]'));

/** A finished drag as a shape, or null when it has no extent (a click with a box tool is not a drawing). */
function shapeOf(tool: MarkTool, color: MediaShape['color'], a: Pt, b: Pt, pen: number[]): MediaShape | null {
  if (tool === 'pen') {
    let pts = simplify(pen);
    if (pts.length === 2) pts = [pts[0], pts[1], pts[0], pts[1]]; // a tap is a dot: never lose a short stroke
    for (let eps = 0.003; pts.length > PEN_MAX_VALUES; eps *= 2) pts = simplify(pen, eps);
    return { kind: 'pen', color, points: pts };
  }
  if (tool === 'arrow') return a.x === b.x && a.y === b.y ? null : { kind: 'arrow', color, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const r = rectFrom(a, b);
  return r.w > 0 && r.h > 0 ? { kind: tool, color, ...r } : null;
}

/**
 * Markup mode of one media tab (an image, or a video paused on a frame): the toolbar in the tab's top-right corner and,
 * while on, an SVG over the media's content box where the shapes are drawn.
 *
 * Lag: the SVG is a child of the pane (the media's scroll container), so it scrolls with the media natively, with no
 * per-frame JS; its box follows resizes and the fit/natural toggle through a ResizeObserver. A drag touches no React
 * state: the live shape is one ref'd element whose attribute is set in place, the store gets the shape once, on
 * pointerup. Skew: coordinates come from `contentBox` of the media element's own rect (it has no border or padding), in
 * client px, so neither the zoom, the scroll nor the device pixel ratio enters them.
 */
export function MarkupLayer({ tabId, media, fit, onAdd }: {
  tabId: string; media: Media; fit: 'contain' | 'natural'; onAdd: (shapes: MediaShape[]) => void;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const offered = useAppSelector((s) => s.controls.protocol >= 4);
  const draft = useAppSelector((s) => selectDraft(s, tabId));
  const [asking, setAsking] = useState(false);
  const pane = media.parentElement;
  const svg = useRef<SVGSVGElement>(null);
  const hit = useRef<SVGRectElement>(null);
  const live = useRef<SVGPathElement>(null);
  const livePen = useRef<SVGPolylineElement>(null);
  const [nat, setNat] = useState<[number, number]>(() => natSize(media));
  const box = useCallback(() => {
    const [w, h] = natSize(media);
    return contentBox(media.getBoundingClientRect(), w, h, fit);
  }, [media, fit]);

  // the overlay's place: the content box in the pane's scrolled coordinates (it scrolls with the media natively)
  const place = useCallback(() => {
    const el = svg.current;
    if (!el || !pane) return;
    const b = box();
    const p = pane.getBoundingClientRect();
    el.style.left = `${b.x - p.x - pane.clientLeft + pane.scrollLeft}px`;
    el.style.top = `${b.y - p.y - pane.clientTop + pane.scrollTop}px`;
    el.style.width = `${b.width}px`;
    el.style.height = `${b.height}px`;
    // a video's controls strip stays the video's (the hit area stops above it)
    const keep = media instanceof HTMLVideoElement && b.height > 0 ? Math.max(0, 1 - VIDEO_CONTROLS_PX / b.height) : 1;
    hit.current?.setAttribute('height', String(keep));
  }, [box, pane, media]);

  // once on, the mode stays through a reconnect (protocol is 0 until the next hello): a drawing never vanishes
  const on = draft.on;
  useLayoutEffect(() => {
    if (!on) return;
    place();
    // focus off the toggle (gone now) or a text field, so R/E/P/A, Enter and Esc reach the mode at once
    svg.current?.focus({ preventScroll: true });
    const sync = () => {
      setNat(natSize(media));
      place();
    };
    media.addEventListener('load', sync);
    media.addEventListener('loadedmetadata', sync);
    window.addEventListener('resize', place);
    const onScroll = () => void (drag.current && (drag.current.box = box()));
    pane?.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    ro?.observe(media);
    if (pane) ro?.observe(pane);
    return () => {
      media.removeEventListener('load', sync);
      media.removeEventListener('loadedmetadata', sync);
      window.removeEventListener('resize', place);
      pane?.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [on, media, pane, place, box]);

  // ---- drawing: refs only until pointerup ----
  // `box`: the content box at pointerdown (no layout read per move); a scroll during the drag refreshes it
  const drag = useRef<{ id: number; a: Pt; b: Pt; pen: number[]; ptsText: string; box: DOMRect } | null>(null);
  const toolRef = useRef(draft);
  toolRef.current = draft;
  const relOf = (e: { clientX: number; clientY: number }, b: DOMRect) => toRel(e.clientX, e.clientY, b);
  const showLive = (d: NonNullable<typeof drag.current>) => {
    const { tool, color } = toolRef.current;
    if (tool === 'pen') return void livePen.current?.setAttribute('points', d.ptsText);
    const s = shapeOf(tool, color, d.a, d.b, d.pen);
    live.current?.setAttribute('d', s ? shapePath(s, nat[0], nat[1]) : '');
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); // no text selection, no image drag
    svg.current?.focus({ preventScroll: true }); // the mode's keys work again after a click in the composer
    (e.target as Element).setPointerCapture?.(e.pointerId); // the hit rect: the svg itself takes no pointer events
    const at = box();
    const a = relOf(e, at);
    const d = { id: e.pointerId, a, b: a, pen: [a.x, a.y], ptsText: `${a.x},${a.y}`, box: at };
    drag.current = d;
    const { tool, color } = toolRef.current;
    (tool === 'pen' ? livePen : live).current?.setAttribute('stroke', color);
    showLive(d);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // every input sample since the last frame, for a stroke as smooth as the pointer (pen only; a box needs the last)
    const native = e.nativeEvent;
    const samples = toolRef.current.tool === 'pen' && typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    for (const p of samples.length ? samples : [native]) {
      const r = relOf(p, d.box);
      d.b = r;
      if (toolRef.current.tool === 'pen') {
        d.pen.push(r.x, r.y);
        d.ptsText += ` ${r.x},${r.y}`;
      }
    }
    showLive(d);
  };
  const finish = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    if (e.type === 'pointerup') d.b = relOf(e, d.box);
    live.current?.setAttribute('d', '');
    livePen.current?.setAttribute('points', '');
    const { tool, color } = toolRef.current;
    const s = shapeOf(tool, color, d.a, d.b, d.pen);
    if (s) dispatch(addShape(tabId, s));
  };

  // ---- entering / leaving ----
  const enter = () => {
    if (media instanceof HTMLVideoElement && !media.paused) media.pause(); // one still frame
    dispatch(setMode(tabId, true));
  };
  const shapes = draft.shapes;
  const leave = useCallback(() => (shapes.length ? setAsking(true) : void dispatch(setMode(tabId, false))), [shapes, dispatch, tabId]);
  const comment = useCallback(() => void (shapes.length && onAdd(shapes)), [shapes, onAdd]);

  // ---- keys: only while on, in the visible tab, outside text fields; capture + preventDefault (the Esc protocol) ----
  useEffect(() => {
    if (!on || asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || editable(e.target) || media.closest('[hidden]')) return;
      const mod = e.metaKey || e.ctrlKey;
      // e.code, not e.key: R/E/P/A and the digits work on any keyboard layout
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        dispatch(undo(tabId));
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        leave();
      } else if (e.key === 'Enter') {
        if ((e.target as Element | null)?.closest?.('button') || !shapes.length) return; // a focused button takes its own Enter
        e.preventDefault();
        comment();
      } else if (!e.shiftKey && TOOL_KEYS[e.code]) {
        e.preventDefault();
        dispatch(setTool(tabId, TOOL_KEYS[e.code]));
      } else if (!e.shiftKey && /^(Digit|Numpad)[1-5]$/.test(e.code)) {
        e.preventDefault();
        dispatch(setColor(tabId, MARK_COLORS[Number(e.code.slice(-1)) - 1]));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [on, asking, media, dispatch, tabId, leave, comment, shapes]);

  const drawn = useMemo(() => shapes.map((s, i) => (
    <path key={i} data-shape={s.kind} d={shapePath(s, nat[0], nat[1])} stroke={s.color} vectorEffect="non-scaling-stroke" />
  )), [shapes, nat]);

  if (!offered && !on) return null;
  return (
    <>
      <div data-anchor-skip className="pointer-events-none absolute top-2 right-3 z-20">
        <MarkupToolbar
          draft={draft}
          onEnter={enter}
          onTool={(tool) => dispatch(setTool(tabId, tool))}
          onColor={(c) => dispatch(setColor(tabId, c))}
          onUndo={() => dispatch(undo(tabId))}
          onComment={comment}
          onLeave={leave}
        />
      </div>
      {on && pane && createPortal(
        <svg
          ref={svg}
          data-markup-layer
          tabIndex={-1}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          fill="none"
          strokeWidth={STROKE_PX}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute z-10 cursor-crosshair touch-none overflow-visible outline-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
        >
          {/* filter: the drop shadow keeps a white or yellow stroke visible on a light frame */}
          <g style={{ filter: 'drop-shadow(0 0 1px rgba(0,0,0,0.7))' }}>
            <rect ref={hit} x="0" y="0" width="1" height="1" fill="transparent" stroke="none" className="pointer-events-auto" />
            {drawn}
            <path ref={live} data-live d="" vectorEffect="non-scaling-stroke" />
            <polyline ref={livePen} data-live points="" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>,
        pane,
      )}
      {asking && (
        <ConfirmDialog
          title={t('markDiscardTitle')}
          body={t('markDiscardBody', shapes.length)}
          confirm={t('markDiscard')}
          onConfirm={() => { setAsking(false); dispatch(clear(tabId)); }}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}

