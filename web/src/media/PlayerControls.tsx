import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useT } from '@/i18n/index.ts';
import { VolumeHighIcon, VolumeLowIcon, VolumeOffIcon } from './playerIcons.tsx';
import type { MediaSnapshot } from './useMediaState.ts';

/** A round icon button of the bar. Keys are the player keys' (usePlayerKeys), so a pressed Space never also clicks it. */
export function BarButton({ label, onClick, children, pressed, className = '' }: {
  label: string; onClick: () => void; children: ReactNode; pressed?: boolean; className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`grid size-8 flex-none cursor-pointer place-items-center rounded-full text-white/90 outline-none hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-primary ${className}`}
    >
      {children}
    </button>
  );
}

const SLIDER = 60;

/** The mute button and, while hovered or focused, a horizontal volume slider (violet fill). */
export function VolumeControl({ media, state, onMute }: { media: HTMLMediaElement; state: MediaSnapshot; onMute: () => void }) {
  const t = useT();
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const level = state.muted ? 0 : state.volume;
  const set = (e: PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !(r.width > 0)) return;
    const v = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) / 100;
    if (v > 0 && media.muted) media.muted = false;
    media.volume = v;
  };
  const Icon = level === 0 ? VolumeOffIcon : level < 0.5 ? VolumeLowIcon : VolumeHighIcon;
  return (
    <div className="group/vol flex items-center">
      <BarButton label={t(state.muted || state.volume === 0 ? 'pb_unmute' : 'pb_mute')} onClick={onMute}><Icon /></BarButton>
      <div className="w-0 overflow-hidden transition-[width] group-focus-within/vol:w-[68px] group-hover/vol:w-[68px]">
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label={t('pb_volume')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          data-volume
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            set(e);
          }}
          onPointerMove={(e) => dragging.current && set(e)}
          onPointerUp={() => void (dragging.current = false)}
          onPointerCancel={() => void (dragging.current = false)}
          className="relative mx-1 flex h-6 cursor-pointer touch-none items-center outline-none"
          style={{ width: SLIDER }}
        >
          <div className="relative h-1 w-full rounded-full bg-white/25">
            <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${level * 100}%` }} />
            <div className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary" style={{ left: `${level * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** The speed button ("1×") and its menu. `onOpen` tells the bar to stay visible while the menu is open. */
export function SpeedMenu({ media, rate, onOpen }: { media: HTMLMediaElement; rate: number; onOpen: (open: boolean) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const toggle = (v: boolean) => { setOpen(v); onOpen(v); };
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) toggle(false); };
    const esc = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      toggle(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => onOpen(false), [onOpen]);
  return (
    <div ref={root} className="relative">
      <button
        ref={btn}
        type="button"
        aria-label={t('pb_speed')}
        title={t('pb_speed')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => toggle(!open)}
        className="h-8 min-w-9 cursor-pointer rounded-full px-2 text-[13px] font-medium text-white/90 tabular-nums outline-none hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-primary"
      >
        {rate}×
      </button>
      {open && (
        <div role="menu" aria-label={t('pb_speed')} className="absolute right-0 bottom-full z-10 mb-2 min-w-20 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {SPEEDS.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === rate}
              onClick={() => { media.playbackRate = r; toggle(false); btn.current?.focus(); }}
              className={`flex w-full cursor-pointer items-center rounded-md px-2 py-1 text-xs outline-none hover:bg-muted focus-visible:bg-muted ${r === rate ? 'font-semibold text-primary' : ''}`}
            >
              {r}×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
