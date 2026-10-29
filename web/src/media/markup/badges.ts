import type { MediaShape } from '@nota-bene/shared';
import { shapesBounds } from './geometry.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Badge radius for a w×h picture: 1.2% of the long edge (a disc ~2.4% across), at least 16 px, so it is >= 30 px across at the 1568 px upload size. */
export const badgeRadius = (w: number, h: number): number => Math.max(16, Math.round(Math.max(w, h) * 0.012));

/**
 * One numbered disc per comment at the top-left corner of its shapes' box (dark disc, white ring, the shape colour
 * inside the ring, white digit), nudged inside the picture and sideways off earlier badges.
 */
export function drawBadges(ctx: Ctx, items: { n: number; shapes: MediaShape[] }[], w: number, h: number): void {
  const r = badgeRadius(w, h);
  const placed: { x: number; y: number }[] = [];
  const clampX = (v: number) => Math.min(Math.max(v, r + 2), w - r - 2);
  const clampY = (v: number) => Math.min(Math.max(v, r + 2), h - r - 2);
  for (const it of items) {
    if (!it.shapes.length) continue;
    const b = shapesBounds(it.shapes);
    let x = b.x * w, y = b.y * h;
    x = clampX(x);
    y = clampY(y);
    // off earlier badges: step right; at the right edge go back to the start and one row down; no room at the bottom: overlap rather than loop
    const x0 = x;
    for (let k = 0; k < 400 && placed.some((p) => Math.hypot(p.x - x, p.y - y) < r * 1.9); k++) {
      if (clampX(x + r * 2) > x) x = clampX(x + r * 2);
      else if (clampY(y + r * 2) > y) { x = x0; y = clampY(y + r * 2); }
      else break;
    }
    placed.push({ x, y });
    const disc = (rad: number, fill: string) => { ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
    disc(r, '#ffffff');
    disc(r * 0.88, it.shapes[0].color);
    disc(r * 0.74, '#111111');
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * (it.n > 9 ? 0.95 : 1.2))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(it.n), x, y + r * 0.05);
  }
}
