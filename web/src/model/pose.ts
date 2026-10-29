import type { ModelCamera } from '@nota-bene/shared';
import { tIn, type Lang } from '@/i18n/index.ts';
import type { CameraPose } from './api.ts';

/** The protocol a server must announce for the client to offer markup on a 3D view (it keeps the anchor's `camera`). */
export const MODEL_MARKUP_PROTOCOL = 9;

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

/**
 * The x scale, about the canvas centre, that puts a mark drawn on a `w`×`h` frame over the same part of the model on a
 * canvas of `cw`×`ch`: the camera's fov is vertical, so at one pose relative y is unchanged and x scales by the ratio of
 * the aspects (the panel or the tree opening changes the canvas aspect without moving the camera). 1 while a size is unknown.
 */
export function aspectScale(w: number, h: number, cw: number, ch: number): number {
  if (!(w > 0 && h > 0 && cw > 0 && ch > 0)) return 1;
  return (w / h) / (cw / ch);
}
