import { describe, it, expect } from 'vitest';
import { parseRange } from './range.ts';

describe('parseRange', () => {
  it('parses closed, open and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 });
    expect(parseRange('bytes=-50', 1000)).toEqual({ start: 950, end: 999 });
  });
  it('clamps the end to the size', () => {
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });
  it('is unsatisfiable at or past the end, or reversed', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });
  it('multi-range, garbage and no header serve the whole file', () => {
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseRange('lines=1-2', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });
});
