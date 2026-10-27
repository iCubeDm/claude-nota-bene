import { expect, it } from 'vitest';
import { centered, clampScale, fitScale, fitView, MAX_SCALE, MIN_SCALE, zoomAt } from './zoom.ts';
import { sha1 } from './sha1.ts';

it('fits a drawing to the pane by its tighter side', () => {
  expect(fitScale(800, 400, 400, 400)).toBe(1);
  expect(fitScale(800, 400, 1600, 200)).toBe(0.5);
  expect(fitScale(0, 0, 100, 100)).toBe(1); // a pane not laid out yet
});

it('centres the fitted drawing', () => {
  expect(fitView(800, 400, 400, 400)).toEqual({ s: 1, tx: 200, ty: 0 });
  expect(centered(100, 100, 200, 200, 0.25)).toEqual({ s: 0.25, tx: 25, ty: 25 });
});

it('clamps the scale to 0.25..8', () => {
  expect(clampScale(0.01)).toBe(MIN_SCALE);
  expect(clampScale(100)).toBe(MAX_SCALE);
  expect(zoomAt({ s: 7, tx: 0, ty: 0 }, 10, 0, 0).s).toBe(8);
  expect(zoomAt({ s: 0.3, tx: 0, ty: 0 }, 0.1, 0, 0).s).toBe(0.25);
});

it('keeps the point under the cursor in place when zooming', () => {
  const v = { s: 1, tx: 10, ty: 20 };
  const [px, py] = [150, 90];
  const [dx, dy] = [(px - v.tx) / v.s, (py - v.ty) / v.s]; // the drawing point under the cursor
  const z = zoomAt(v, 2.5, px, py);
  expect(z.s).toBe(2.5);
  expect(dx * z.s + z.tx).toBeCloseTo(px);
  expect(dy * z.s + z.ty).toBeCloseTo(py);
});

it('sha1 matches the known vectors', () => {
  expect(sha1('abc')).toBe('a9993e36' + '4706816a' + 'ba3e2571' + '7850c26c' + '9cd0d89d');
  expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  expect(sha1('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  expect(sha1('диаграмма')).toMatch(/^[0-9a-f]{40}$/);
});
