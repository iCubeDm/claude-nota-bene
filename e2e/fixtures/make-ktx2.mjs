// Regenerates models/ktx2.glb (committed): a quad textured with a 4x4 KTX2 image through KHR_texture_basisu.
// Run from the repo root: node e2e/fixtures/make-ktx2.mjs
// No Basis encoder is available offline, so the KTX2 inside is the uncompressed RGBA8 kind (vkFormat 43): it still goes
// through KTX2Loader (the loader the model tab used to lack), just not through the Basis transcoder worker.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const W = 4;
const px = Buffer.alloc(W * W * 4);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) px.set((x + y) % 2 ? [20, 60, 220, 255] : [240, 60, 20, 255], (y * W + x) * 4);

function ktx2() {
  const dfdWords = 6 + 16; // basic block header (6 words) + 4 samples of 4 words
  const dfd = Buffer.alloc(4 + dfdWords * 4);
  dfd.writeUInt32LE(dfd.length, 0);
  const w = (i, v) => dfd.writeUInt32LE(v >>> 0, 4 + i * 4);
  w(0, 0); // vendor 0, descriptor type 0 (basic)
  w(1, 2 | ((dfdWords * 4) << 16)); // version 2, block size
  w(2, 1 | (1 << 8) | (2 << 16)); // RGBSDA, BT.709, sRGB transfer
  w(3, 0); // 1x1x1x1 texel block
  w(4, 4); // 4 bytes per texel
  w(5, 0);
  [0, 1, 2, 15].forEach((ch, i) => {
    w(6 + i * 4, (i * 8) | (7 << 16) | ((ch | (ch === 15 ? 0x40 : 0)) << 24)); // bit offset, 8 bits, channel
    w(7 + i * 4, 0);
    w(8 + i * 4, 0);
    w(9 + i * 4, 255);
  });
  const head = Buffer.alloc(80);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  const u32 = [43, 1, W, W, 0, 0, 1, 1, 0]; // vkFormat R8G8B8A8_SRGB, typeSize, w, h, depth, layers, faces, levels, supercompression
  u32.forEach((v, i) => head.writeUInt32LE(v, 12 + i * 4));
  const dfdAt = 80 + 24;
  head.writeUInt32LE(dfdAt, 48);
  head.writeUInt32LE(dfd.length, 52);
  const dataAt = Math.ceil((dfdAt + dfd.length) / 16) * 16;
  const level = Buffer.alloc(24);
  level.writeBigUInt64LE(BigInt(dataAt), 0);
  level.writeBigUInt64LE(BigInt(px.length), 8);
  level.writeBigUInt64LE(BigInt(px.length), 16);
  return Buffer.concat([head, level, dfd, Buffer.alloc(dataAt - dfdAt - dfd.length), px]);
}

const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const pos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const nor = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
const parts = [pos, nor, uv, idx].map((a) => pad4(Buffer.from(a.buffer)));
const img = pad4(ktx2());
const bin = Buffer.concat([...parts, img]);
let at = 0;
const views = [...parts, img].map((b) => ({ buffer: 0, byteOffset: (at += b.length) - b.length, byteLength: b.length }));
views[0].target = views[1].target = views[2].target = 34962;
views[3].target = 34963;
const json = {
  asset: { version: '2.0', generator: 'nota-bene e2e/fixtures/make-ktx2.mjs' },
  extensionsUsed: ['KHR_texture_basisu'],
  extensionsRequired: ['KHR_texture_basisu'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Quad', mesh: 0 }],
  meshes: [{ name: 'Quad', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{ name: 'Checker', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
  textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
  images: [{ bufferView: 4, mimeType: 'image/ktx2' }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
    { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
    { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
  ],
  bufferViews: views,
  buffers: [{ byteLength: bin.length }],
};
const j = pad4(Buffer.from(JSON.stringify(json))).fill(0x20, Buffer.byteLength(JSON.stringify(json)));
const head = Buffer.alloc(12);
head.write('glTF', 0, 'latin1');
head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
const chunk = (len, type, body) => { const h = Buffer.alloc(8); h.writeUInt32LE(len, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
const out = fileURLToPath(new URL('./project/models/ktx2.glb', import.meta.url));
fs.writeFileSync(out, Buffer.concat([head, chunk(j.length, 'JSON', j), chunk(bin.length, 'BIN\0', bin)]));
console.log('wrote', out);
