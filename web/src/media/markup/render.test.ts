import { describe, expect, it } from 'vitest';
import type { MediaShape } from '@nota-bene/shared';
import { drawShapes } from './render';

function fakeCtx() {
  const calls: Array<[string, ...number[]]> = [];
  const ctx: Record<string, unknown> = { strokeStyle: '', lineWidth: 0, lineCap: '', lineJoin: '' };
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'ellipse', 'save', 'restore'])
    ctx[m] = (...a: number[]) => { calls.push([m, ...a]); };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, calls };
}
const W = 1920, H = 1080;

describe('drawShapes', () => {
  it('rect → strokeRect in px, colour and width set', () => {
    const { ctx, raw, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'rect', x: 0.42, y: 0.4, w: 0.16, h: 0.24, color: '#ff3b30' } satisfies MediaShape], W, H);
    expect(calls).toContainEqual(['strokeRect', 806.4, 432, 307.2, 259.2]);
    expect(raw.strokeStyle).toBe('#ff3b30');
    expect(raw.lineWidth).toBe(4);
    expect(raw.lineCap).toBe('round');
  });
  it('ellipse → ellipse(cx, cy, rx, ry, …)', () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'ellipse', x: 0.25, y: 0.25, w: 0.5, h: 0.5, color: '#0a84ff' } satisfies MediaShape], W, H);
    const e = calls.find((c) => c[0] === 'ellipse')!;
    expect(e.slice(1, 5)).toEqual([960, 540, 480, 270]);
  });
  it('arrow → shaft plus a 2-segment head', () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'arrow', x1: 0.1, y1: 0.5, x2: 0.5, y2: 0.5, color: '#34c759' } satisfies MediaShape], W, H);
    expect(calls.filter((c) => c[0] === 'moveTo').length).toBe(1 + 2);
    expect(calls.filter((c) => c[0] === 'lineTo').length).toBe(1 + 2);
    const head = calls.filter((c) => c[0] === 'lineTo').slice(1);
    for (const h of head) expect(h[1]).toBeLessThan(960); // head points back from the tip
  });
  it('pen → moveTo + lineTo per point', () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [{ kind: 'pen', points: [0, 0, 0.5, 0.5, 1, 1], color: '#ffffff' } satisfies MediaShape], W, H);
    expect(calls.filter((c) => c[0] === 'moveTo')).toEqual([['moveTo', 0, 0]]);
    expect(calls.filter((c) => c[0] === 'lineTo')).toEqual([['lineTo', 960, 540], ['lineTo', 1920, 1080]]);
  });
});
