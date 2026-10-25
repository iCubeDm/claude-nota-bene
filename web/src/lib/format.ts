/** Compact token count: 1234567 -> 1.2M, 45678 -> 46k, 999 -> 999 (prototype fmtK). */
export const fmtK = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
