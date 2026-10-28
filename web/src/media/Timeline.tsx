import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useT } from '@/i18n/index.ts';
import { formatTime, layoutMarkers, type MarkerIn } from './timelineMath.ts';
import { seekAndPause } from './mediaController.ts';
import type { MediaSnapshot } from './useMediaState.ts';

type Hover = { x: number; time: number } | { x: number; marker: number };

/**
 * The bar's seek line: buffered and played parts, a scrubber that grows on hover, a time tooltip, and a tick for every
 * comment with a time (`items`; click seeks there and pauses). The line is the one slider; the ticks are siblings over
 * it, so pressing a tick never starts a scrub. Keys are not handled here: the player keys (usePlayerKeys) already
 * act on a focused slider, and a second handler would double every arrow.
 */
export function Timeline({ media, state, items, onScrub }: {
  media: HTMLMediaElement; state: MediaSnapshot; items: MarkerIn[]; onScrub: (on: boolean) => void;
}) {
  const t = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const { duration, time } = state;
  const known = Number.isFinite(duration) && duration > 0;

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => onScrub(false), [onScrub]);

  const markers = useMemo(() => layoutMarkers(items, duration, width), [items, duration, width]);

  const at = (clientX: number): { x: number; time: number } | null => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !(r.width > 0) || !known) return null;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { x: clientX - (wrap.current?.getBoundingClientRect().left ?? r.left), time: f * duration };
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = at(e.clientX);
    if (!p) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setScrubbing(true);
    onScrub(true);
    media.currentTime = p.time;
    setHover(p);
  };
  const move = (e: PointerEvent) => {
    const p = at(e.clientX);
    if (!p) return;
    if (scrubbing) media.currentTime = p.time;
    setHover(p);
  };
  const end = () => {
    if (!scrubbing) return;
    setScrubbing(false);
    onScrub(false);
  };

  const pct = known ? Math.max(0, Math.min(100, (time / duration) * 100)) : 0;
  const tip = hover && 'marker' in hover ? markers[hover.marker] : null;
  return (
    <div ref={wrap} className="relative">
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('pb_seek')}
        aria-valuemin={0}
        aria-valuemax={known ? Math.floor(duration) : 0}
        aria-valuenow={Math.floor(time)}
        aria-valuetext={t('pb_ofTotal', formatTime(time), formatTime(duration))}
        data-timeline
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onPointerLeave={() => !scrubbing && setHover(null)}
        className="group/tl flex h-4 cursor-pointer touch-none items-center outline-none focus-visible:[&>div]:ring-2 focus-visible:[&>div]:ring-primary"
      >
        <div ref={track} className={`relative w-full rounded-full bg-foreground/15 transition-[height] ${scrubbing ? 'h-1.5' : 'h-1 group-hover/tl:h-1.5'}`}>
          {state.buffered.map(([a, b], i) => known && (
            <div key={i} data-buffered className="absolute inset-y-0 rounded-full bg-foreground/30" style={{ left: `${(a / duration) * 100}%`, width: `${((b - a) / duration) * 100}%` }} />
          ))}
          <div data-played className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
          <div
            data-scrubber
            className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow transition-opacity ${scrubbing ? 'opacity-100' : 'opacity-0 group-hover/tl:opacity-100'}`}
            style={{ left: `${pct}%` }}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-4 items-center">
        <div className="relative h-full w-full">
          {markers.map((m, i) => (
            <button
              key={m.ids[0]}
              type="button"
              tabIndex={-1}
              data-marker={m.ids.join(' ')}
              data-count={m.count}
              aria-label={`${formatTime(m.time)} · ${t('pb_comments', m.count)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerEnter={(e) => setHover({ x: e.currentTarget.getBoundingClientRect().left + e.currentTarget.getBoundingClientRect().width / 2 - (wrap.current?.getBoundingClientRect().left ?? 0), marker: i })}
              onPointerLeave={() => setHover(null)}
              onClick={() => seekAndPause(media, m.time)}
              className="pointer-events-auto absolute top-0 flex h-full w-2 -translate-x-1/2 cursor-pointer items-center justify-center"
              style={{ left: `${m.pct}%` }}
            >
              <span className="h-3 w-[3px] rounded-sm bg-[var(--nb-accent)]" style={{ opacity: m.dim ? 0.45 : 1 }} />
            </button>
          ))}
        </div>
      </div>
      {hover && (
        <div
          data-timeline-tip
          className="pointer-events-none absolute bottom-full mb-2 max-w-60 -translate-x-1/2 rounded-md bg-black/85 px-2 py-1 text-xs whitespace-nowrap text-white shadow"
          style={{ left: `clamp(${tip ? '7.5rem' : '2rem'}, ${hover.x}px, calc(100% - ${tip ? '7.5rem' : '2rem'}))` }}
        >
          {tip ? (
            <>
              <div><span className="text-[var(--nb-accent)]">●</span> {formatTime(tip.time)} · {t('pb_comments', tip.count)}</div>
              {tip.text && <div className="truncate text-white/70">{tip.text}</div>}
            </>
          ) : 'time' in hover ? formatTime(hover.time) : null}
        </div>
      )}
    </div>
  );
}
