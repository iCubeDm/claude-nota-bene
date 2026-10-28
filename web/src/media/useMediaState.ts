import { useEffect, useReducer } from 'react';

export type MediaSnapshot = {
  time: number; duration: number; paused: boolean; ended: boolean; volume: number; muted: boolean; rate: number;
  /** buffered ranges as [start, end] seconds */
  buffered: [number, number][];
};

const EVENTS = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'volumechange', 'ratechange', 'emptied'] as const;

function read(el: HTMLMediaElement): MediaSnapshot {
  const buffered: [number, number][] = [];
  const b = el.buffered;
  for (let i = 0; b && i < b.length; i++) buffered.push([b.start(i), b.end(i)]);
  return {
    time: el.currentTime, duration: el.duration, paused: el.paused, ended: el.ended,
    volume: el.volume, muted: el.muted, rate: el.playbackRate, buffered,
  };
}

/**
 * The element's state for rendering, re-read on its events and, while it plays, on every animation frame (timeupdate
 * comes ~4 times a second: too coarse for a progress bar).
 */
export function useMediaState(el: HTMLMediaElement): MediaSnapshot {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      bump();
      raf = !el.paused && !el.ended ? requestAnimationFrame(frame) : 0;
    };
    const on = () => {
      bump();
      if (!raf && !el.paused && !el.ended) raf = requestAnimationFrame(frame);
    };
    for (const ev of EVENTS) el.addEventListener(ev, on);
    on();
    return () => {
      for (const ev of EVENTS) el.removeEventListener(ev, on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [el]);
  return read(el);
}
