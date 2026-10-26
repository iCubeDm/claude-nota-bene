import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaShape } from '@nota-bene/shared';
import { drawShapes, renderMarks } from './render';

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

describe('renderMarks', () => {
  afterEach(() => void vi.unstubAllGlobals());
  it('the frame is filled white before the source is drawn (an alpha source must not turn black in the JPEG); the layer stays transparent', async () => {
    const canvases: Array<{ calls: Array<[string, ...unknown[]]>; fill: unknown[] }> = [];
    class FakeCanvas {
      width: number; height: number;
      rec: { calls: Array<[string, ...unknown[]]>; fill: unknown[] } = { calls: [], fill: [] };
      constructor(w: number, h: number) { this.width = w; this.height = h; canvases.push(this.rec); }
      getContext() {
        const rec = this.rec;
        const ctx: Record<string, unknown> = { lineWidth: 0, strokeStyle: '' };
        let fillStyle: unknown = '#000000';
        Object.defineProperty(ctx, 'fillStyle', { get: () => fillStyle, set: (v) => void (fillStyle = v) });
        for (const m of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'ellipse', 'drawImage', 'fillRect', 'save', 'restore'])
          ctx[m] = (...a: unknown[]) => {
            rec.calls.push([m, ...a.filter((x) => typeof x === 'number')]);
            if (m === 'fillRect') rec.fill.push(fillStyle);
          };
        return ctx;
      }
      convertToBlob() { return Promise.resolve(new Blob(['x'])); }
    }
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const src = {} as CanvasImageSource;
    await renderMarks(src, 40, 30, [{ kind: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.5, color: '#ff3b30' }]);
    const [frame, layer] = canvases;
    const names = frame!.calls.map((c) => c[0]);
    expect(names.indexOf('fillRect')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('fillRect')).toBeLessThan(names.indexOf('drawImage'));
    expect(frame!.calls.find((c) => c[0] === 'fillRect')).toEqual(['fillRect', 0, 0, 40, 30]);
    expect(frame!.fill).toEqual(['#ffffff']);
    expect(layer!.calls.map((c) => c[0])).not.toContain('fillRect');
    expect(layer!.calls.map((c) => c[0])).not.toContain('drawImage');
  });
});
