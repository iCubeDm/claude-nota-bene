import { expect, it } from 'vitest';
import { placeList, scrollTopFor } from './placeList.ts';

const vw = 1000;
const vh = 800;

it('goes above the field when it fits there', () => {
  expect(placeList({ top: 700, bottom: 740, left: 20 }, 320, 300, vw, vh)).toEqual({ left: 20, top: 394, maxHeight: 300 });
});

it('a field at the top: below, capped to the room below', () => {
  expect(placeList({ top: 40, bottom: 80, left: 20 }, 320, 900, vw, vh)).toEqual({ left: 20, top: 86, maxHeight: 706 });
});

it('fits on neither side: the roomier side, capped, never past the window edge', () => {
  const p = placeList({ top: 500, bottom: 540, left: 900 }, 320, 700, vw, vh);
  expect(p).toEqual({ left: 672, top: 8, maxHeight: 486 });
  expect(p.top + p.maxHeight).toBeLessThanOrEqual(500 - 6);
});

it('scrollTopFor keeps an option visible inside the list only', () => {
  expect(scrollTopFor(50, 20, 0, 100)).toBe(0); // visible
  expect(scrollTopFor(120, 20, 0, 100)).toBe(40); // below: bottom-align
  expect(scrollTopFor(10, 20, 60, 100)).toBe(10); // above: top-align
});
