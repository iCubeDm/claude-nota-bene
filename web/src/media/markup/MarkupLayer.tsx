import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { MARK_COLORS, PEN_MAX_VALUES, type MediaShape } from '@nota-bene/shared';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { box as rectBox, rectFrom, shapePath, shapesBounds, simplify, toRel } from './geometry.ts';
import { MarkupToolbar } from './MarkupToolbar.tsx';
import { HALO, HALO_PX, shapeEls, STROKE_PX, useNatSize, useOverlayPlacement, type Media } from './overlay.tsx';
import { addShape, clear, selectDraft, setColor, setMode, setTool, undo, type MarkTool } from './slice.ts';

type Pt = { x: number; y: number };

const TOOL_KEYS: Record<string, MarkTool> = { KeyR: 'rect', KeyE: 'ellipse', KeyP: 'pen', KeyA: 'arrow' };

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
/**
 * `onAdd(shapes, at)`: Comment was asked for; `at` is the client rect around the shapes, or the toolbar's when they are
 * scrolled out of sight (where the comment popup opens). `held`: the popup is open, so the mode's keys are off.
 */
export function MarkupLayer({ tabId, media, fit, onAdd, held = false }: {
  tabId: string; media: Media; fit: 'contain' | 'natural'; onAdd: (shapes: MediaShape[], at: DOMRect) => void; held?: boolean;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const offered = useAppSelector((s) => s.controls.protocol >= 4);
  const draft = useAppSelector((s) => selectDraft(s, tabId));
  const [asking, setAsking] = useState(false);
  const pane = media.parentElement;
  const svg = useRef<SVGSVGElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const live = useRef<SVGPathElement>(null);
  const liveHalo = useRef<SVGPathElement>(null);
  const livePen = useRef<SVGPolylineElement>(null);
  const livePenHalo = useRef<SVGPolylineElement>(null);
  const [nat, syncNat] = useNatSize(media);

  // once on, the mode stays through a reconnect (protocol is 0 until the next hello): a drawing never vanishes
  const on = draft.on;
  const box = useOverlayPlacement(svg, media, fit, on);
  useLayoutEffect(() => {
    if (!on) return;
    syncNat();
    // focus off the toggle (gone now) or a text field, so R/E/P/A, Enter and Esc reach the mode at once
    svg.current?.focus({ preventScroll: true });
    const onScroll = () => void (drag.current && (drag.current.box = box()));
    pane?.addEventListener('scroll', onScroll, { passive: true });
    return () => pane?.removeEventListener('scroll', onScroll);
  }, [on, pane, box, syncNat]);

  // ---- drawing: refs only until pointerup ----
  // `box`: the content box at pointerdown (no layout read per move); a scroll during the drag refreshes it.
  // `tool`/`color`: fixed at pointerdown, so a key pressed mid-drag changes the next shape, not this one.
  type Drag = { id: number; a: Pt; b: Pt; pen: number[]; ptsText: string; box: DOMRect; tool: MarkTool; color: MediaShape['color'] };
  const drag = useRef<Drag | null>(null);
  const toolRef = useRef(draft);
  toolRef.current = draft;
  const relOf = (e: { clientX: number; clientY: number }, b: DOMRect) => toRel(e.clientX, e.clientY, b);
  const showLive = (d: Drag) => {
    if (d.tool === 'pen') {
      livePen.current?.setAttribute('points', d.ptsText);
      return void livePenHalo.current?.setAttribute('points', d.ptsText);
    }
    const s = shapeOf(d.tool, d.color, d.a, d.b, d.pen);
    const path = s ? shapePath(s, nat[0], nat[1]) : '';
    live.current?.setAttribute('d', path);
    liveHalo.current?.setAttribute('d', path);
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault(); // no text selection, no image drag
    svg.current?.focus({ preventScroll: true }); // the mode's keys work again after a click in the composer
    (e.target as Element).setPointerCapture?.(e.pointerId); // the hit rect: the svg itself takes no pointer events
    const at = box();
    const a = relOf(e, at);
    const { tool, color } = toolRef.current;
    const d: Drag = { id: e.pointerId, a, b: a, pen: [a.x, a.y], ptsText: `${a.x},${a.y}`, box: at, tool, color };
    drag.current = d;
    (tool === 'pen' ? livePen : live).current?.setAttribute('stroke', color);
    showLive(d);
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // every input sample since the last frame, for a stroke as smooth as the pointer (pen only; a box needs the last)
    const native = e.nativeEvent;
    const samples = d.tool === 'pen' && typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    for (const p of samples.length ? samples : [native]) {
      const r = relOf(p, d.box);
      d.b = r;
      if (d.tool === 'pen') {
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
    for (const el of [live.current, liveHalo.current]) el?.setAttribute('d', '');
    for (const el of [livePen.current, livePenHalo.current]) el?.setAttribute('points', '');
    const s = shapeOf(d.tool, d.color, d.a, d.b, d.pen);
    if (s) dispatch(addShape(tabId, s));
  };

  // ---- entering / leaving ----
  const enter = () => {
    if (media instanceof HTMLVideoElement && !media.paused) media.pause(); // one still frame
    dispatch(setMode(tabId, true));
  };
  const shapes = draft.shapes;
  const leave = useCallback(() => (shapes.length ? setAsking(true) : void dispatch(setMode(tabId, false))), [shapes, dispatch, tabId]);
  const comment = useCallback(() => {
    if (!shapes.length) return;
    const b = box();
    const s = shapesBounds(shapes);
    const at = rectBox(b.x + s.x * b.width, b.y + s.y * b.height, s.w * b.width, s.h * b.height);
    // visible = inside the pane's box and the window
    const v = pane?.getBoundingClientRect();
    const seen = at.right >= Math.max(0, v?.left ?? 0) && at.left <= Math.min(window.innerWidth, v?.right ?? Infinity)
      && at.bottom >= Math.max(0, v?.top ?? 0) && at.top <= Math.min(window.innerHeight, v?.bottom ?? Infinity);
    onAdd(shapes, seen || !toolbar.current ? at : toolbar.current.getBoundingClientRect());
  }, [shapes, onAdd, box, pane]);

  // ---- keys: only while on, in the visible tab, with focus on nothing (body) or in this tab's pane or toolbar; never in
  // a text field. Focus in the feed keeps Esc for the agent and Enter for a link. Capture + preventDefault (Esc protocol).
  useEffect(() => {
    if (!on || asking || held) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || editable(e.target) || media.closest('[hidden]')) return;
      const f = document.activeElement;
      if (f && f !== document.body && !pane?.contains(f) && !toolbar.current?.contains(f)) return;
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
  }, [on, asking, held, media, dispatch, tabId, leave, comment, shapes]);

  const drawn = useMemo(() => shapeEls(shapes, nat[0], nat[1]), [shapes, nat]);

  if (!offered && !on) return null;
  return (
    <>
      <div ref={toolbar} data-anchor-skip className="pointer-events-none absolute top-2 right-3 z-20">
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
          {/* the hit area: the svg itself takes no pointer events; while marking the video has no native controls */}
          <rect x="0" y="0" width="1" height="1" fill="transparent" stroke="none" className="pointer-events-auto" />
          {drawn}
          <path ref={liveHalo} d="" stroke={HALO} strokeWidth={HALO_PX} vectorEffect="non-scaling-stroke" />
          <path ref={live} data-live d="" vectorEffect="non-scaling-stroke" />
          <polyline ref={livePenHalo} points="" stroke={HALO} strokeWidth={HALO_PX} vectorEffect="non-scaling-stroke" />
          <polyline ref={livePen} data-live points="" vectorEffect="non-scaling-stroke" />
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

