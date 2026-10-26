/**
 * How long a compaction usually takes here. The SDK reports no progress while it compacts (only `status: compacting`,
 * then `status: null` and the boundary with its `duration_ms`), so the bar is an estimate: elapsed time against the
 * median of the last durations seen in this browser.
 */
const KEY = 'nb.compactMs';
const KEEP = 10;
/** the user's compactions measured 30–125 s, median ~75 s (transcripts, 2026-10-26) */
export const DEFAULT_MS = 75_000;

function read(): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > 0) : [];
  } catch {
    return [];
  }
}

/** A live boundary's duration_ms; only the last KEEP are kept. */
export function recordCompactMs(ms: number): void {
  if (!(ms > 0)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...read(), ms].slice(-KEEP)));
  } catch {
    // storage full or off: the estimate stays at what it was
  }
}

export function expectedCompactMs(): number {
  const v = read().sort((a, b) => a - b);
  if (v.length === 0) return DEFAULT_MS;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * 0..1 for the bar: linear to 0.9 at the expected time, then creeping towards 0.99, so a slow compaction never shows
 * a full bar before it ends.
 */
export function compactProgress(elapsed: number, expected: number): number {
  const e = Math.max(0, elapsed);
  if (e <= expected) return (0.9 * e) / expected;
  return 0.9 + 0.09 * (1 - Math.exp(-(e - expected) / expected));
}

/** 75000 -> "1:15" */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
