import { describe, it, expect } from 'vitest';
import { fuzzyScore } from './fuzzy.ts';

describe('fuzzyScore', () => {
  it('a file-name hit outranks a directory hit', () => {
    expect(fuzzyScore('src/App.tsx', 'app')).toBeGreaterThan(fuzzyScore('apps/x/readme.md', 'app'));
  });
  it('a non-subsequence is -1', () => {
    expect(fuzzyScore('src/App.tsx', 'zzq')).toBe(-1);
    expect(fuzzyScore('abc', 'cba')).toBe(-1);
  });
  it('is case-insensitive and matches scattered letters', () => {
    expect(fuzzyScore('src/App.tsx', 'APP')).toBeGreaterThan(0);
    expect(fuzzyScore('src/components/Button.tsx', 'scb')).toBeGreaterThanOrEqual(0);
  });
});
