import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_MS, compactProgress, expectedCompactMs, mmss, recordCompactMs } from './compactTiming.ts';

beforeEach(() => localStorage.clear());

it('expects the default until a compaction was seen, then the median of the last ten', () => {
  expect(expectedCompactMs()).toBe(DEFAULT_MS);
  for (const ms of [40_000, 120_000, 60_000]) recordCompactMs(ms);
  expect(expectedCompactMs()).toBe(60_000);
  recordCompactMs(80_000);
  expect(expectedCompactMs()).toBe(70_000);
  for (let i = 0; i < 10; i++) recordCompactMs(30_000);
  expect(JSON.parse(localStorage.getItem('nb.compactMs')!)).toHaveLength(10);
  expect(expectedCompactMs()).toBe(30_000);
});

it('ignores junk in storage and non-positive durations', () => {
  localStorage.setItem('nb.compactMs', '{"x":1}');
  expect(expectedCompactMs()).toBe(DEFAULT_MS);
  localStorage.setItem('nb.compactMs', 'not json');
  recordCompactMs(0);
  recordCompactMs(50_000);
  expect(expectedCompactMs()).toBe(50_000);
});

it('the bar reaches 90% at the expected time and never 100% before the end', () => {
  expect(compactProgress(-5, 60_000)).toBe(0);
  expect(compactProgress(30_000, 60_000)).toBeCloseTo(0.45);
  expect(compactProgress(60_000, 60_000)).toBeCloseTo(0.9);
  const slow = compactProgress(600_000, 60_000);
  expect(slow).toBeGreaterThan(0.98);
  expect(slow).toBeLessThan(0.99);
  expect(compactProgress(61_000, 60_000)).toBeGreaterThan(compactProgress(60_000, 60_000));
});

it('formats minutes and seconds', () => {
  expect(mmss(75_000)).toBe('1:15');
  expect(mmss(4_400)).toBe('0:04');
  expect(mmss(-1)).toBe('0:00');
});
