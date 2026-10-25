import type { Anchor, AnchorSource } from '@nota-bene/shared';

// Pure string logic over the normalised text from ./text.
export const CONTEXT = 32;

export function makeAnchor(source: AnchorSource, text: string, start: number, end: number): Anchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start > end) {
    throw new RangeError(`bad anchor range ${start}..${end} for text of length ${text.length}`);
  }
  return {
    source, start, end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export function resolveAnchor(a: Anchor, text: string): { start: number; end: number } | null {
  const { quote } = a;
  if (text.slice(a.start, a.end) === quote && a.end <= text.length) return { start: a.start, end: a.end };
  if (quote === '') return null;

  let best = -1;
  let bestScore = -1;
  let count = 0;
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    count++;
    const score =
      commonSuffix(a.prefix, text.slice(Math.max(0, i - a.prefix.length), i)) +
      commonPrefix(a.suffix, text.slice(i + quote.length, i + quote.length + a.suffix.length));
    if (score > bestScore || (score === bestScore && Math.abs(i - a.start) < Math.abs(best - a.start))) {
      best = i;
      bestScore = score;
    }
  }
  if (count === 0) return null;
  if (count > 1 && bestScore === 0) return null;
  return { start: best, end: best + quote.length };
}
