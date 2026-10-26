import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '@/i18n/index.ts';

const STEP = 16;
/** a panel never takes more than this share of the window, so the middle column keeps room */
const MAX_SHARE = 0.45;

const clampTo = (w: number, min: number) => Math.round(Math.max(min, Math.min(w, Math.max(min, window.innerWidth * MAX_SHARE))));

function readWidth(key: string, initial: number, min: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? clampTo(v, min) : initial;
  } catch {
    return initial;
  }
}

/**
 * A docked panel's width: dragged or set with the keyboard, persisted under `key` (one width for every project). The
 * panels also cap it at 45vw in CSS, for a window made narrower after the width was set.
 */
export function usePanelWidth(key: string, initial: number, min: number) {
  const [width, setWidth] = useState(() => readWidth(key, initial, min));
  const set = useCallback((w: number) => {
    const next = clampTo(w, min);
    setWidth(next);
    try { localStorage.setItem(key, String(next)); } catch { /* storage unavailable: not persisted */ }
  }, [key, min]);
  const reset = useCallback(() => {
    setWidth(initial);
    try { localStorage.removeItem(key); } catch { /* not persisted */ }
  }, [key, initial]);
  return { width, set, reset };
}

/**
 * The drag edge of a docked panel (IntelliJ: drag the border). `edge`: which side of the panel it sits on, so dragging
 * towards the middle column widens the panel. Arrows step 16 px; double-click or Home restores the default width.
 */
export function PanelResizer({ edge, width, onWidth, onReset, min, label }: {
  edge: 'left' | 'right'; width: number; onWidth: (w: number) => void; onReset: () => void; min: number; label: string;
}) {
  const t = useT();
  const drag = useRef<{ x: number; w: number } | null>(null);
  const sign = edge === 'right' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: width };
    document.body.style.cursor = 'col-resize';
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onWidth(drag.current.w + sign * (e.clientX - drag.current.x));
  };
  const end = () => {
    drag.current = null;
    document.body.style.cursor = '';
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) onWidth(width + STEP);
    else if (e.key === shrink) onWidth(width - STEP);
    else if (e.key === 'Home') onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      title={t('resizeTip')}
      data-resizer={edge}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={`absolute inset-y-0 z-[6] w-1.5 cursor-col-resize touch-none outline-none hover:bg-primary/40 focus-visible:bg-primary/60 ${edge === 'right' ? '-right-[3px]' : '-left-[3px]'}`}
    />
  );
}
