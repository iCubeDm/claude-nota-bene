/**
 * SHA-1 of the UTF-8 text as 40 hex chars. Synchronous on purpose: a diagram tab's id is made inside a reducer, and
 * crypto.subtle is async (and absent on plain http). It is an id, not a security boundary.
 */
export function sha1(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << (24 - (bytes.length % 4) * 8);
  words[words.length - 1] = (bytes.length * 8) >>> 0;
  words[words.length - 2] = Math.floor((bytes.length * 8) / 2 ** 32);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rol = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let o = 0; o < words.length; o += 16) {
    for (let i = 0; i < 16; i++) w[i] = words[o + i];
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rol(a, 5) + f + e + k + w[i]) >>> 0;
      [e, d, c, b, a] = [d, c, rol(b, 30) >>> 0, a, tmp];
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}
