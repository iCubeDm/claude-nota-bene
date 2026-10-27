/** The drawing's transform inside its pane: scale `s`, then translate by (tx, ty) from the pane's top-left. */
export type View = { s: number; tx: number; ty: number };
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** The scale at which a w x h drawing just fits a cw x ch pane (not clamped: a huge drawing may fit below MIN_SCALE). */
export const fitScale = (cw: number, ch: number, w: number, h: number): number =>
  w > 0 && h > 0 && cw > 0 && ch > 0 ? Math.min(cw / w, ch / h) : 1;

/** The drawing at scale `s`, centred in the pane. */
export const centered = (cw: number, ch: number, w: number, h: number, s: number): View => ({ s, tx: (cw - w * s) / 2, ty: (ch - h * s) / 2 });

export const fitView = (cw: number, ch: number, w: number, h: number): View => centered(cw, ch, w, h, fitScale(cw, ch, w, h));

/** Multiplies the scale by `factor` (clamped) keeping the drawing point under (px, py) where it is. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const s = clampScale(v.s * factor);
  const k = s / v.s;
  return { s, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}
