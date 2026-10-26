import { expect, it } from 'vitest';
import { enterRoot } from '../../tabs/slice.ts';
import { addShape, markupSlice, setMode, type MarkupState } from './slice.ts';

const r = markupSlice.reducer;
const shape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 } as const;
const go = (root: string, first = false) => enterRoot({ root, first, tabs: null, dirs: null });

it('a folder switch keeps each folder\'s drafts (by tab id) and a switch back restores them', () => {
  let s: MarkupState = r(undefined, go('/a', true));
  s = r(s, setMode('file:x.png', true));
  s = r(s, addShape('file:x.png', shape));
  s = r(s, go('/b'));
  expect(s.drafts).toEqual({}); // /b has its own x.png: not /a's drawing
  s = r(s, addShape('file:x.png', { ...shape, x: 0.5 }));
  s = r(s, go('/a'));
  expect(s.drafts['file:x.png']).toMatchObject({ on: true, shapes: [shape] });
  s = r(s, go('/b'));
  expect(s.drafts['file:x.png']!.shapes).toEqual([{ ...shape, x: 0.5 }]);
});

it('the first root merges: a draft made before the root was known stays', () => {
  let s: MarkupState = r(undefined, addShape('file:x.png', shape));
  s = r(s, go('/a', true));
  expect(s.drafts['file:x.png']!.shapes).toEqual([shape]);
});
