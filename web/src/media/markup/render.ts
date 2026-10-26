import { MARK_MAX_BYTES, type MediaShape } from '@nota-bene/shared';
import { encode } from '../../attachments/image';

export { MARK_MAX_BYTES };

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const HEAD_ANGLE = (25 * Math.PI) / 180;

/** Draws shapes on a 2D context sized w×h (relative → px). Stroke width max(3, round(min(w,h)/250)) px. */
export function drawShapes(ctx: Ctx, shapes: MediaShape[], w: number, h: number): void {
  const lineWidth = Math.max(3, Math.round(Math.min(w, h) / 250));
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of shapes) {
    ctx.strokeStyle = s.color;
    switch (s.kind) {
      case 'rect':
        ctx.strokeRect(s.x * w, s.y * h, s.w * w, s.h * h);
        break;
      case 'ellipse':
        ctx.beginPath();
        ctx.ellipse((s.x + s.w / 2) * w, (s.y + s.h / 2) * h, (s.w / 2) * w, (s.h / 2) * h, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'arrow': {
        const x1 = s.x1 * w, y1 = s.y1 * h, x2 = s.x2 * w, y2 = s.y2 * h;
        const back = Math.atan2(y1 - y2, x1 - x2); // from the tip back along the shaft
        const len = Math.max(12, 4 * lineWidth);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        for (const a of [back + HEAD_ANGLE, back - HEAD_ANGLE]) {
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 + len * Math.cos(a), y2 + len * Math.sin(a));
        }
        ctx.stroke();
        break;
      }
      case 'pen': {
        const p = s.points;
        if (p.length < 2) break;
        ctx.beginPath();
        ctx.moveTo(p[0] * w, p[1] * h);
        for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i] * w, p[i + 1] * h);
        ctx.stroke();
        break;
      }
    }
  }
}

function makeCanvas(w: number, h: number): { c: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx } {
  let c: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
  else {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d') as Ctx | null;
  if (!ctx) throw new Error('no 2d canvas');
  return { c, ctx };
}

/** `frame.jpg` (q 0.9, the source drawn first) and `layer.png` (shapes only, transparent), both natural size; `scale` < 1 only when a file exceeded MARK_MAX_BYTES. */
export async function renderMarks(
  source: CanvasImageSource, w: number, h: number, shapes: MediaShape[],
): Promise<{ frame: Blob; layer: Blob; scale: number }> {
  let scale = 1;
  for (;;) {
    const pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));
    const f = makeCanvas(pw, ph);
    f.ctx.drawImage(source, 0, 0, pw, ph);
    drawShapes(f.ctx, shapes, pw, ph);
    const l = makeCanvas(pw, ph);
    drawShapes(l.ctx, shapes, pw, ph);
    const [frame, layer] = await Promise.all([encode(f.c, 'image/jpeg', 0.9), encode(l.c, 'image/png')]);
    if ((frame.size <= MARK_MAX_BYTES && layer.size <= MARK_MAX_BYTES) || (pw === 1 && ph === 1)) return { frame, layer, scale };
    scale *= 0.75;
  }
}
