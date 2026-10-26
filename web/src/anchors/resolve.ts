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

const FAST_CONTEXT = 8;

/**
 * The stored offsets still hold only when the text around them still reads as it did: the quote alone is not enough
 * (an old anchor on a user message's raw text, now rendered as markdown, can find the same word at its old offset
 * and mark the wrong one). A context shorter than CONTEXT means the text began or ended there, so it must still.
 */
function offsetsHold(a: Anchor, text: string): boolean {
  if (a.end > text.length || text.slice(a.start, a.end) !== a.quote) return false;
  const p = a.prefix.slice(-FAST_CONTEXT);
  const s = a.suffix.slice(0, FAST_CONTEXT);
  if (a.start < p.length || text.slice(a.start - p.length, a.start) !== p || text.slice(a.end, a.end + s.length) !== s) return false;
  if (a.prefix.length < CONTEXT && a.start !== a.prefix.length) return false;
  if (a.suffix.length < CONTEXT && a.end + a.suffix.length !== text.length) return false;
  return true;
}

export function resolveAnchor(a: Anchor, text: string): { start: number; end: number } | null {
  const { quote } = a;
  if (offsetsHold(a, text)) return { start: a.start, end: a.end };
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
