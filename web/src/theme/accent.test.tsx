import { describe, expect, it } from 'vitest';

/** oklch -> relative luminance (Ottosson's OKLab matrices), enough for a WCAG contrast ratio. */
function luminance(L: number, C: number, hDeg: number): number {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

describe('--nb-accent (R-M6-1)', () => {
  it('is readable on the card and the page background (>= 3:1, non-text UI minimum)', () => {
    const accent = luminance(0.70, 0.20, 60);
    expect(contrast(accent, luminance(0.22, 0.02, 260))).toBeGreaterThanOrEqual(3); // card
    expect(contrast(accent, luminance(0.15, 0.02, 260))).toBeGreaterThanOrEqual(3); // background
  });
});
