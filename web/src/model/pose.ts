import type { ModelCamera } from '@nota-bene/shared';
import { tIn, type Lang } from '@/i18n/index.ts';
import type { CameraPose } from './api.ts';

/** `n` to 3 significant digits as plain text (no exponent, no "-0"): 1.23456 → "1.23", 1234.5 → "1230". */
export function sig3(n: number): string {
  const r = Number(n.toPrecision(3));
  return String(r === 0 ? 0 : r);
}

const vec = (v: readonly number[]): string => `(${v.map(sig3).join(', ')})`;

/** The camera as the batch text names it, in `lang`: `camera (x, y, z) → (x, y, z), fov N°`. */
export const cameraLine = (c: ModelCamera, lang: Lang): string => tIn(lang, 'camLine', vec(c.position), vec(c.target), sig3(c.fov));

/** Relative slack of two camera poses being "the same view": a thousandth of the camera's distance to its target. */
const NEAR = 1e-3;
/** Is the live camera at the comment's pose? Distances are judged against the comment's own camera distance, so a tiny model and a huge one behave alike. */
export function nearPose(c: ModelCamera, p: CameraPose): boolean {
  const dist = Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]);
  const eps = Math.max(dist, 1e-6) * NEAR;
  return c.position.every((x, i) => Math.abs(x - p.position[i]!) <= eps)
    && c.target.every((x, i) => Math.abs(x - p.target[i]!) <= eps)
    && Math.abs(c.fov - p.fov) <= 0.01;
}
