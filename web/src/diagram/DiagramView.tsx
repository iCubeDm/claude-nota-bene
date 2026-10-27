import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DiagramTab } from '@/tabs/slice.ts';
import { renderDiagram, svgSize, type Rendered } from './render.ts';
import { centered, fitView, zoomAt, type View } from './zoom.ts';

/** A pointer that moved less than this between down and up is a click, not a drag. */
const DRAG_PX = 3;

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * One diagram, full size (R-M7-12): fitted to the pane; wheel or pinch zooms around the cursor, drag pans, a click
 * toggles fit / 100%, `0` goes back to fit. `free` is the user's own view; null means "fitted" (and follows the pane's size).
 * The drawing comes from the same renderers as the chat's (render.ts), so mermaid is loaded and svg sanitized in one place.
 */
export function DiagramView({ tab, active }: { tab: DiagramTab; active: boolean }) {
  const pane = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ cw: 0, ch: 0 });
  const [free, setFree] = useState<View | null>(null);

  useEffect(() => {
    let live = true;
    void renderDiagram(tab.lang, tab.source).then((r) => live && setRendered(r));
    return () => { live = false; };
  }, [tab.lang, tab.source]);

  // the drawing at its own size, so the pane's transform is the only thing that scales it
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el || !rendered || !('svg' in rendered)) return;
    el.innerHTML = rendered.svg;
    const svg = el.querySelector('svg');
    if (!svg) return;
    const s = svgSize(svg);
    svg.setAttribute('width', String(s.w));
    svg.setAttribute('height', String(s.h));
    svg.style.maxWidth = 'none';
    setSize(s);
  }, [rendered]);

  const measure = useCallback(() => {
    const el = pane.current;
    if (el) setBox((b) => (b.cw === el.clientWidth && b.ch === el.clientHeight ? b : { cw: el.clientWidth, ch: el.clientHeight }));
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = pane.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const view = free ?? fitView(box.cw, box.ch, size.w, size.h);
  const viewRef = useRef(view);
  viewRef.current = view;

  // React's onWheel is passive: preventDefault (a pinch is ctrl+wheel; the browser would zoom the whole page) needs a native listener
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      setFree(zoomAt(viewRef.current, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '0' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) setFree(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const drag = useRef<{ x: number; y: number; from: View; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, from: viewRef.current, moved: false };
    pane.current?.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    setFree({ ...d.from, tx: d.from.tx + dx, ty: d.from.ty + dy });
  };
  const onPointerUp = () => {
    justDragged.current = !!drag.current?.moved; // the click that follows a drag is not a toggle
    drag.current = null;
  };
  const onClick = () => {
    if (justDragged.current) { justDragged.current = false; return; }
    setFree(free ? null : centered(box.cw, box.ch, size.w, size.h, 1));
  };

  return (
    <div
      ref={pane}
      data-pane={tab.id}
      data-anchor-skip
      hidden={!active}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
      // mermaid's dark theme is drawn for a dark ground, a plain svg for a light one (as in the chat)
      className={`grid-pane relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing ${tab.lang === 'svg' ? 'bg-[oklch(0.97_0.005_260)]' : ''}`}
    >
      {rendered && 'error' in rendered ? (
        <p className="p-4 text-sm text-destructive">{rendered.error}</p>
      ) : (
        <div
          ref={sheet}
          data-testid="diagram-sheet"
          style={{ width: size.w, height: size.h, transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}
        />
      )}
    </div>
  );
}
