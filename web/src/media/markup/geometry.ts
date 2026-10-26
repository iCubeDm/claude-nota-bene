import type { MediaShape } from '@nota-bene/shared';

export const round4 = (v: number): number => Math.round(v * 10000) / 10000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function box(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() { return this; } } as DOMRect;
}

/** The rendered media's content box in client px: object-fit: contain inside `el`'s box, or the element box at natural size. */
export function contentBox(elRect: DOMRect, natW: number, natH: number, fit: 'contain' | 'natural'): DOMRect {
  if (fit === 'natural' || natW <= 0 || natH <= 0) return box(elRect.x, elRect.y, elRect.width, elRect.height);
  const scale = Math.min(elRect.width / natW, elRect.height / natH);
  const w = natW * scale;
  const h = natH * scale;
  return box(elRect.x + (elRect.width - w) / 2, elRect.y + (elRect.height - h) / 2, w, h);
}

/** Pointer → relative [0,1]², clamped, 4 decimals. */
export function toRel(clientX: number, clientY: number, b: DOMRect): { x: number; y: number } {
  return {
    x: b.width > 0 ? round4(clamp01((clientX - b.x) / b.width)) : 0,
    y: b.height > 0 ? round4(clamp01((clientY - b.y) / b.height)) : 0,
  };
}

/** Drop pen points closer than `eps` (relative) to the previous kept one; always keeps the first and last. */
export function simplify(points: number[], eps = 0.0015): number[] {
  const n = points.length / 2;
  if (n <= 2) return points.slice();
  const out = [points[0], points[1]];
  for (let i = 1; i < n - 1; i++) {
    const x = points[2 * i], y = points[2 * i + 1];
    if (Math.hypot(x - out[out.length - 2], y - out[out.length - 1]) >= eps) out.push(x, y);
  }
  out.push(points[2 * n - 2], points[2 * n - 1]);
  return out;
}

/** Normalised rect from a drag's two corners (any direction). */
export function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  return {
    x: round4(Math.min(a.x, b.x)), y: round4(Math.min(a.y, b.y)),
    w: round4(Math.abs(a.x - b.x)), h: round4(Math.abs(a.y - b.y)),
  };
}

/** One line per shape for the batch, e.g. `rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)`. */
export function describeShape(s: MediaShape, natW: number, natH: number): string {
  const n = (v: number) => String(round4(v));
  const px = (v: number, nat: number) => Math.round(v * nat);
  switch (s.kind) {
    case 'rect':
      return `rect x=${n(s.x)} y=${n(s.y)} w=${n(s.w)} h=${n(s.h)} (px ${px(s.x, natW)},${px(s.y, natH)} ${px(s.w, natW)}×${px(s.h, natH)})`;
    case 'ellipse': {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2, rx = s.w / 2, ry = s.h / 2;
      return `ellipse cx=${n(cx)} cy=${n(cy)} rx=${n(rx)} ry=${n(ry)} (px ${px(cx, natW)},${px(cy, natH)} r ${px(rx, natW)}×${px(ry, natH)})`;
    }
    case 'arrow':
      return `arrow (${n(s.x1)},${n(s.y1)})→(${n(s.x2)},${n(s.y2)}) (px ${px(s.x1, natW)},${px(s.y1, natH)}→${px(s.x2, natW)},${px(s.y2, natH)})`;
    case 'pen': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < s.points.length; i += 2) {
        minX = Math.min(minX, s.points[i]); maxX = Math.max(maxX, s.points[i]);
        minY = Math.min(minY, s.points[i + 1]); maxY = Math.max(maxY, s.points[i + 1]);
      }
      const w = maxX - minX, h = maxY - minY;
      return `pen ${s.points.length / 2} pts, bbox x=${n(minX)} y=${n(minY)} w=${n(w)} h=${n(h)} (px ${px(minX, natW)},${px(minY, natH)} ${px(w, natW)}×${px(h, natH)})`;
    }
  }
}
