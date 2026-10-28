import { expect, it } from 'vitest';
import { formatTime, layoutMarkers } from './timelineMath.ts';

it('formats m:ss, and h:mm:ss from an hour', () => {
  expect(formatTime(5)).toBe('0:05');
  expect(formatTime(5.9)).toBe('0:05');
  expect(formatTime(90)).toBe('1:30');
  expect(formatTime(3723)).toBe('1:02:03');
  expect(formatTime(3600)).toBe('1:00:00');
  expect(formatTime(NaN)).toBe('0:00');
  expect(formatTime(-3)).toBe('0:00');
  expect(formatTime(Infinity)).toBe('0:00');
});

const c = (id: string, time: number, o: { dim?: boolean; text?: string } = {}) => ({ id, time, text: o.text ?? id, dim: o.dim ?? false });

it('places ticks at time/duration in percent', () => {
  const m = layoutMarkers([c('a', 30), c('b', 75)], 100, 1000);
  expect(m.map((x) => [x.time, x.pct, x.count])).toEqual([[30, 30, 1], [75, 75, 1]]);
});

it('merges ticks within 4 px, counting them; the tick sits at the earliest and keeps its text (40 chars)', () => {
  // 100 s over 1000 px: 4 px = 0.4 s
  const m = layoutMarkers([c('b', 10.3, { text: 'x'.repeat(60) }), c('a', 10), c('far', 11)], 100, 1000);
  expect(m.map((x) => [x.time, x.count, x.ids])).toEqual([[10, 2, ['a', 'b']], [11, 1, ['far']]]);
  expect(m[0].text).toBe('a');
  expect(layoutMarkers([c('a', 1, { text: 'y'.repeat(60) })], 100, 1000)[0].text).toHaveLength(40);
});

it('a tick is dimmed only when all its comments are; unknown duration places nothing; no width merges equal times only', () => {
  expect(layoutMarkers([c('a', 10, { dim: true }), c('b', 10.1)], 100, 1000)[0].dim).toBe(false);
  expect(layoutMarkers([c('a', 10, { dim: true }), c('b', 10.1, { dim: true })], 100, 1000)[0].dim).toBe(true);
  expect(layoutMarkers([c('a', 1)], NaN, 1000)).toEqual([]);
  expect(layoutMarkers([c('a', 1)], 0, 1000)).toEqual([]);
  expect(layoutMarkers([c('a', 5), c('b', 5), c('d', 5.01)], 100, 0).map((x) => x.count)).toEqual([2, 1]);
});
