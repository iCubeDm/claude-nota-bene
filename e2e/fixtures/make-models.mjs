// Regenerates the tiny 3D fixtures the "files" e2e project ships (e2e/fixtures/project/models/).
// Run from the repo root: node e2e/fixtures/make-models.mjs   (they are committed; this is only how they were made)
//   models/cube.glb      a coloured cube with one animation clip, "spin"
//   models/ext/box.gltf  the same cube as .gltf + external box.bin + external tex.png (the resolver's case)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./project/models/', import.meta.url));

// a cube, 24 vertices (4 per face, so each face has its own normal and uv)
const faces = [
  { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
];
const pos = [], nor = [], uv = [], idx = [];
faces.forEach((f, i) => {
  f.v.forEach((p, k) => { pos.push(...p.map((x) => x * 0.5)); nor.push(...f.n); uv.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0); });
  const b = i * 4;
  idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
});
const times = [0, 1, 2];
const h = Math.SQRT1_2;
const quats = [0, 0, 0, 1, 0, h, 0, h, 0, 1, 0, 0]; // 0°, 90°, 180° about Y (quaternions x y z w)

// one binary buffer: positions | normals | uvs | indices (padded to 4) | anim times | anim rotations
function pack() {
  const parts = [
    ['pos', new Float32Array(pos)], ['nor', new Float32Array(nor)], ['uv', new Float32Array(uv)],
    ['idx', new Uint16Array(idx)], ['t', new Float32Array(times)], ['q', new Float32Array(quats)],
  ];
  const views = {};
  let at = 0;
  const bufs = [];
  for (const [k, arr] of parts) {
    const b = Buffer.from(arr.buffer);
    const pad = (4 - (b.length % 4)) % 4;
    views[k] = { byteOffset: at, byteLength: b.length };
    bufs.push(b, Buffer.alloc(pad));
    at += b.length + pad;
  }
  return { bin: Buffer.concat(bufs), views };
}

function gltfJson(bin, views, { bufferUri, texUri, color }) {
  const bv = ['pos', 'nor', 'uv', 'idx', 't', 'q'].map((k) => ({ buffer: 0, ...views[k], ...(k === 'idx' ? { target: 34963 } : k === 't' || k === 'q' ? {} : { target: 34962 }) }));
  return {
    asset: { version: '2.0', generator: 'nota-bene e2e/fixtures/make-models.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Cube', mesh: 0 }],
    meshes: [{ name: 'Cube', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'Paint', pbrMetallicRoughness: { ...(texUri ? { baseColorTexture: { index: 0 } } : { baseColorFactor: color }), metallicFactor: 0.2, roughnessFactor: 0.5 } }],
    ...(texUri ? { textures: [{ source: 0 }], images: [{ uri: texUri }] } : {}),
    animations: [{ name: 'spin', samplers: [{ input: 4, output: 5, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 5, componentType: 5126, count: 3, type: 'VEC4' },
    ],
    bufferViews: bv,
    buffers: [{ byteLength: bin.length, ...(bufferUri ? { uri: bufferUri } : {}) }],
  };
}

function glb(json, bin) {
  const j = Buffer.from(JSON.stringify(json));
  const jp = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const bp = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jp.length + 8 + bp.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(jp.length, 0x4e4f534a), jp, ch(bp.length, 0x004e4942), bp]);
}

const { bin, views } = pack();
fs.mkdirSync(`${out}ext`, { recursive: true });
fs.writeFileSync(`${out}cube.glb`, glb(gltfJson(bin, views, { color: [0.9, 0.25, 0.2, 1] }), bin));
fs.writeFileSync(`${out}ext/box.bin`, bin);
// a 1x1 png texture next to the .gltf
fs.writeFileSync(`${out}ext/tex.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync(`${out}ext/box.gltf`, `${JSON.stringify(gltfJson(bin, views, { bufferUri: 'box.bin', texUri: 'tex.png' }), null, 1)}\n`);
console.log('wrote', fs.readdirSync(out), fs.readdirSync(`${out}ext`));
