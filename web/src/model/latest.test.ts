import { expect, it } from 'vitest';
import { createLatest } from './latest.ts';

it('only the newest token is current; invalidate retires all', () => {
  const l = createLatest();
  const a = l.next();
  expect(l.current(a)).toBe(true);
  const b = l.next();
  expect([l.current(a), l.current(b)]).toEqual([false, true]);
  l.invalidate();
  expect(l.current(b)).toBe(false);
});
