import { expect, it } from 'vitest';
import { fmtElapsed } from './time.ts';

it('elapsed formatting: Ns under a minute, else m:ss', () => {
  expect(fmtElapsed(0)).toBe('0s');
  expect(fmtElapsed(59_400)).toBe('59s');
  expect(fmtElapsed(60_000)).toBe('1:00');
  expect(fmtElapsed(125_000)).toBe('2:05');
  expect(fmtElapsed(-5000)).toBe('0s');
});
