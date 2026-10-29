import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BlendConverter, findBlender, MAC_BLENDER, SANDBOX_PROFILE } from './blend.ts';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fileRoutes } from './fileRoutes.ts';

// A stand-in for Blender: `--version`, else it logs its argv (blend.test.log next to it) and acts on the input's bytes:
// FAIL = exit 1 with a message, HANG = never ends (ignores SIGTERM when STUBBORN), EMPTY = exit 0 without output.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('Blender 9.9.9\\n\\tbuild date: x'); process.exit(0); }
const log = path.join(__dirname, 'spawns.log');
const input = a.find((x) => x.endsWith('.blend'));
const body = fs.readFileSync(input, 'utf8');
fs.appendFileSync(log, JSON.stringify({ argv: a, cwd: process.cwd(), env: Object.keys(process.env), pid: process.pid }) + '\\n');
const out = a[a.indexOf('--') + 1];
if (body.startsWith('REFUSE')) { console.log('noise\\nNB-REFUSED ["/etc/passwd","G: GeometryNodeImportText"]\\nBlender quit'); process.exit(3); }
if (body.startsWith('FAIL')) { console.error('line1\\nError: boom ' + body); process.exit(1); }
if (body.startsWith('HANG')) { if (body.includes('STUBBORN')) process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (body.startsWith('EMPTY')) process.exit(0);
else if (body.startsWith('MUTATE')) { fs.appendFileSync(input, '+'); fs.writeFileSync(out, 'GLB:' + body); process.exit(0); }
else if (body.startsWith('SLOW')) setTimeout(() => { fs.writeFileSync(out, 'GLB:' + body); process.exit(0); }, 300);
else { fs.writeFileSync(out, 'GLB:' + body); process.exit(0); }
`;

let dir: string;
let fake: string;
let state: string;
const spawns = () => {
  try { return fs.readFileSync(path.join(path.dirname(fake), 'spawns.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: string[]; pid: number }); } catch { return []; }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conv = (o: Partial<ConstructorParameters<typeof BlendConverter>[0]> = {}) =>
  new BlendConverter({ stateDir: () => state, blender: () => fake, sandbox: false, ...o });

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-blend-')));
  fake = path.join(dir, 'bin', 'blender');
  fs.mkdirSync(path.dirname(fake));
  fs.writeFileSync(fake, FAKE, { mode: 0o755 });
  state = path.join(dir, 'state');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('findBlender', () => {
  const yes = (...ok: string[]) => (p: string) => ok.includes(p);
  it('NOTA_BENE_BLENDER first, and authoritative', () => {
    expect(findBlender({ NOTA_BENE_BLENDER: '/x/b', PATH: '/p' }, yes('/x/b', '/p/blender', MAC_BLENDER))).toBe('/x/b');
    expect(findBlender({ NOTA_BENE_BLENDER: '/nonexistent', PATH: '/p' }, yes('/p/blender', MAC_BLENDER))).toBeNull();
  });
  it('then blender on PATH, then the macOS app, else none', () => {
    expect(findBlender({ PATH: '/a:/p' }, yes('/p/blender', MAC_BLENDER))).toBe('/p/blender');
    expect(findBlender({ PATH: '/a' }, yes(MAC_BLENDER))).toBe(MAC_BLENDER);
    expect(findBlender({ PATH: '/a' }, yes())).toBeNull();
  });
});

describe('BlendConverter', () => {
  it('converts with the safe flags, paths after --, no secrets in the environment, then serves the cache without a spawn', async () => {
    process.env.NB_TEST_SECRET = 'hunter2';
    const c = conv();
    const file = path.join(dir, `we"ird ';$(touch pwned) \`x\`.blend`);
    fs.writeFileSync(file, 'cube');
    const before = spawns().length;
    const r = await c.convert({ file, base: dir });
    expect(fs.readFileSync(r.glb, 'utf8')).toBe('GLB:cube');
    const s = spawns().slice(before);
    expect(s).toHaveLength(1);
    const argv = s[0]!.argv;
    expect(argv.slice(0, 5)).toEqual(['-b', '--disable-autoexec', '--factory-startup', '--offline-mode', '-noaudio']);
    expect(argv[5]).toBe(file); // opened in place (relative textures need their neighbours): one argv element, never a shell word
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual([expect.stringMatching(/out\.glb$/), dir]); // output, then the allowed base
    expect(argv[argv.indexOf('--python') + 1]).toMatch(/blend[\\/]export\.py$/);
    expect(argv.indexOf('--')).toBeGreaterThan(argv.indexOf('--python'));
    expect(s[0]!.env).not.toContain('NB_TEST_SECRET');
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
    expect(r.glb).toBe(path.join(state, 'cache', 'blend', `${r.hash}-9.9.9.glb`));
    const again = await c.convert({ file, base: dir });
    expect(again).toEqual(r);
    expect(spawns().slice(before)).toHaveLength(1);
    delete process.env.NB_TEST_SECRET;
  });

  it('the same bytes at another location or in another project are converted (and checked) again', async () => {
    const c = conv();
    fs.mkdirSync(path.join(dir, 'locA'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'locB'), { recursive: true });
    const a = path.join(dir, 'locA', 'same.blend');
    const b = path.join(dir, 'locB', 'same.blend');
    fs.writeFileSync(a, 'same bytes');
    fs.writeFileSync(b, 'same bytes');
    const before = spawns().length;
    const r1 = await c.convert({ file: a, base: dir });
    const r2 = await c.convert({ file: b, base: dir }); // another folder
    const r3 = await c.convert({ file: a, base: path.join(dir, 'locA') }); // another project root
    expect(new Set([r1.hash, r2.hash, r3.hash]).size).toBe(3);
    expect(spawns().slice(before)).toHaveLength(3);
    await c.convert({ file: a, base: dir }); // the same place again: a hit
    expect(spawns().slice(before)).toHaveLength(3);
  });

  it('identical requests in flight share one spawn; different ones run one at a time', async () => {
    const c = conv();
    const before = spawns().length;
    const [a, b, d] = await Promise.all([
      c.convert({ bytes: Buffer.from('SLOW-one') }), c.convert({ bytes: Buffer.from('SLOW-one') }), c.convert({ bytes: Buffer.from('SLOW-two') }),
    ]);
    expect(a).toEqual(b);
    expect(d.hash).not.toBe(a.hash);
    expect(spawns().slice(before)).toHaveLength(2);
  });

  it('a failing export is 422 with the last lines of the output; no output is 422 too', async () => {
    const c = conv();
    await expect(c.convert({ bytes: Buffer.from('FAIL x') })).rejects.toMatchObject({ status: 422, code: 'export-failed', detail: expect.stringContaining('Error: boom FAIL x') });
    await expect(c.convert({ bytes: Buffer.from('EMPTY') })).rejects.toMatchObject({ status: 422 });
    // a failure is not cached
    expect(fs.readdirSync(path.join(state, 'cache', 'blend')).filter((n) => n.startsWith('work-'))).toEqual([]);
  });

  it('a timeout is 504 and the process is gone (SIGKILL after the grace when it ignores SIGTERM)', async () => {
    const c = conv({ timeoutMs: 200, graceMs: 200 });
    const t0 = Date.now();
    await expect(c.convert({ bytes: Buffer.from('HANG STUBBORN') })).rejects.toMatchObject({ status: 504, code: 'timeout' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    expect(alive(spawns().at(-1)!.pid)).toBe(false);
    // the queue goes on after it
    await expect(c.convert({ bytes: Buffer.from('after') })).resolves.toBeTruthy();
  });

  it('dispose() kills the running Blender and later requests are refused', async () => {
    const c = conv();
    const before = spawns().length;
    const p = c.convert({ bytes: Buffer.from('HANG STUBBORN dispose') });
    const settled = p.then(() => 'ok', (e: { code: string }) => e.code);
    while (spawns().length === before) await sleep(20);
    const pid = spawns().at(-1)!.pid;
    expect(alive(pid)).toBe(true);
    c.dispose();
    await expect(settled).resolves.toBe('closing');
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(20);
    expect(alive(pid)).toBe(false); // SIGKILL: even a process that ignores SIGTERM is gone
    await expect(c.convert({ bytes: Buffer.from('later') })).rejects.toMatchObject({ code: 'closing' });
    expect(fs.readdirSync(path.join(state, 'cache', 'blend')).filter((n) => n.startsWith('work-'))).toEqual([]);
  });

  it('a file that changes while Blender reads it is served but not cached under the old hash', async () => {
    const file = path.join(dir, 'mutating.blend');
    fs.writeFileSync(file, 'MUTATE one');
    const r = await conv().convert({ file, base: dir });
    expect(r.transient).toBe(true);
    expect(fs.existsSync(r.glb)).toBe(true);
    expect(fs.readdirSync(path.join(state, 'cache', 'blend')).some((n) => n.startsWith(createHash('sha256').update('MUTATE one').digest('hex')))).toBe(false);
  });

  it('only a missing binary is "no Blender"; other spawn failures say what they are', async () => {
    const noexec = path.join(dir, 'bin', 'noexec');
    fs.writeFileSync(noexec, '#!/bin/sh\necho Blender 1.0\n', { mode: 0o644 });
    // --version fails with EACCES: that is a failed version probe (501), but the spawn itself:
    const fake2 = path.join(dir, 'bin', 'flaky');
    fs.writeFileSync(fake2, FAKE, { mode: 0o755 });
    const c = conv({ blender: () => fake2 });
    await c.convert({ bytes: Buffer.from('warm') }); // version cached
    fs.chmodSync(fake2, 0o644);
    await expect(c.convert({ bytes: Buffer.from('another') })).rejects.toMatchObject({ status: 500, code: 'spawn-failed' });
  });

  it('no Blender is 501', async () => {
    expect(conv({ blender: () => null }).available()).toBe(false);
    await expect(conv({ blender: () => null }).convert({ bytes: Buffer.from('x') })).rejects.toMatchObject({ status: 501, code: 'no-blender' });
    await expect(conv({ blender: () => path.join(dir, 'nope') }).convert({ bytes: Buffer.from('x') })).rejects.toMatchObject({ status: 501 });
  });
});

describe('GET /model', () => {
  let server: http.Server;
  let port: number;
  let root: string;
  const hub = new EventHub();
  const allowedHosts: string[] = [];
  beforeAll(async () => {
    root = path.join(dir, 'proj');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'a.blend'), 'route-cube');
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'outside.blend'), 'out');
    fs.symlinkSync(path.join(dir, 'outside.blend'), path.join(root, 'link.blend'));
    server = http.createServer(httpHandler({
      hub, webDist: dir, allowedHosts, info: () => ({}),
      extra: fileRoutes({ root: () => root, hub, complete: async () => [], blend: conv() }),
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    allowedHosts.push(`127.0.0.1:${port}`);
  });
  afterAll(() => new Promise((r) => server.close(r)));
  const get = (q: string, method = 'GET') => fetch(`http://127.0.0.1:${port}/model?${q}`, { method });

  it('serves the GLB with its content hash as ETag and the safety headers', async () => {
    const r = await get('path=sub%2Fa.blend');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('model/gltf-binary');
    expect(r.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await r.text()).toBe('GLB:route-cube');
    const h = await get('path=sub%2Fa.blend', 'HEAD');
    expect(h.headers.get('etag')).toBe(r.headers.get('etag'));
  });

  it('validates the path: extension 400, traversal and symlink escapes 403, missing 404', async () => {
    expect((await get('path=a.txt')).status).toBe(400);
    expect((await get('')).status).toBe(400);
    expect((await get('path=..%2Foutside.blend')).status).toBe(403);
    expect((await get('path=%2Fetc%2Fx.blend')).status).toBe(403);
    expect((await get('path=link.blend')).status).toBe(403);
    expect((await get('path=none.blend')).status).toBe(404);
    expect((await get('path=sub')).status).toBe(400);
    expect((await get('path=sub%2Fa.blend&src=nope')).status).toBe(400);
  });

  it('refuses a cross-site request (it would start a process); same-origin and non-browser clients pass', async () => {
    const q = `http://127.0.0.1:${port}/model?path=sub%2Fa.blend`;
    expect((await fetch(q, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await fetch(q, { headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    expect((await fetch(q, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('answers a failing export 422 and a missing Blender 501, as JSON', async () => {
    fs.writeFileSync(path.join(root, 'bad.blend'), 'FAIL route');
    const bad = await get('path=bad.blend');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: 'export-failed', detail: expect.stringContaining('boom') });
    fs.writeFileSync(path.join(root, 'ref.blend'), 'REFUSE');
    const ref = await get('path=ref.blend');
    expect(ref.status).toBe(422);
    expect(await ref.json()).toMatchObject({ error: 'outside-refs', paths: ['/etc/passwd', 'G: GeometryNodeImportText'] });
    const s2 = http.createServer(httpHandler({
      hub, webDist: dir, allowedHosts, info: () => ({}),
      extra: fileRoutes({ root: () => root, hub, complete: async () => [], blend: conv({ blender: () => null }) }),
    }));
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const p2 = (s2.address() as AddressInfo).port;
    allowedHosts.push(`127.0.0.1:${p2}`);
    const r = await fetch(`http://127.0.0.1:${p2}/model?path=sub%2Fa.blend`);
    expect(r.status).toBe(501);
    expect(await r.json()).toMatchObject({ error: 'no-blender' });
    await new Promise((res) => s2.close(res));
  });
});

// Tests with the real Blender; skipped where there is none
const real = findBlender();
describe.skipIf(!real)('real Blender', () => {
  let rd: string; // a project root
  let outside: string;
  const make = async (where: string, body: string) => {
    // test-only: the script text is built here from our own temp paths
    const { execFileSync } = await import('node:child_process');
    const script = path.join(dir, 'make.py');
    fs.writeFileSync(script, `import bpy, sys, os\nbpy.ops.wm.read_factory_settings(use_empty=True)\nOUT = sys.argv[sys.argv.index("--") + 1]\n${body}\n`);
    execFileSync(real!, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', where], { stdio: 'ignore' });
  };
  const textured = (img: string, pack = false) => `
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.active_object
mat = bpy.data.materials.new('M'); mat.use_nodes = True
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
img = bpy.data.images.new('t', 4, 4)
img.filepath_raw = ${JSON.stringify(img)}
img.file_format = 'PNG'
img.save()
${pack ? 'img.pack()' : ''}
tex.image = img
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
cube.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath=OUT)`;
  const glbJson = (file: string) => { const b = fs.readFileSync(file); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()) as { images?: unknown[] }; };
  const c = () => new BlendConverter({ stateDir: () => path.join(dir, 'real-state') });
  beforeAll(() => {
    rd = path.join(dir, 'realproj');
    outside = path.join(dir, 'realoutside');
    fs.mkdirSync(path.join(rd, 'sub'), { recursive: true });
    fs.mkdirSync(outside);
  });

  it('converts a .blend made by Blender itself to a glTF binary', async () => {
    const blend = path.join(rd, 'plain.blend');
    await make(blend, 'bpy.ops.mesh.primitive_cube_add()\nbpy.ops.wm.save_as_mainfile(filepath=OUT)');
    const r = await c().convert({ file: blend, base: rd });
    expect(fs.readFileSync(r.glb).subarray(0, 4).toString('latin1')).toBe('glTF');
  }, 60_000);

  it('a relative texture (//tex.png next to the .blend) comes through: the GLB has the image', async () => {
    const blend = path.join(rd, 'sub', 'rel.blend');
    // the image is saved next to the .blend by a relative path, so the file stores `//tex.png`
    await make(blend, `bpy.ops.wm.save_as_mainfile(filepath=OUT)\n${textured('//tex.png').replace('bpy.ops.wm.save_as_mainfile(filepath=OUT)', 'bpy.ops.wm.save_mainfile()')}`);
    expect(fs.existsSync(path.join(rd, 'sub', 'tex.png'))).toBe(true);
    const r = await c().convert({ file: blend, base: rd });
    expect(glbJson(r.glb).images).toHaveLength(1);
  }, 60_000);

  it('a packed image is fine, also from a branch blob (bytes)', async () => {
    const blend = path.join(rd, 'packed.blend');
    await make(blend, textured(path.join(rd, 'packed-src.png'), true));
    const r1 = await c().convert({ file: blend, base: rd });
    expect(glbJson(r1.glb).images).toHaveLength(1);
    const r2 = await new BlendConverter({ stateDir: () => path.join(dir, 'real-state2') }).convert({ bytes: fs.readFileSync(blend) });
    expect(glbJson(r2.glb).images).toHaveLength(1);
  }, 60_000);

  it('an image outside the project (absolute path, or through a symlink) is refused with its path', async () => {
    const png = path.join(outside, 'secret.png');
    const blend = path.join(rd, 'abs.blend');
    await make(blend, textured(png));
    await expect(c().convert({ file: blend, base: rd })).rejects.toMatchObject({ status: 422, code: 'outside-refs', paths: [fs.realpathSync(png)].map(() => expect.stringContaining('secret.png')) });
    // a symlink inside the project that leads outside
    fs.symlinkSync(outside, path.join(rd, 'link'));
    const viaLink = path.join(rd, 'viaLink.blend');
    await make(viaLink, textured(path.join(rd, 'link', 'secret2.png')));
    await expect(c().convert({ file: viaLink, base: rd })).rejects.toMatchObject({ code: 'outside-refs' });
  }, 60_000);

  it('an unpacked reference in a branch blob is refused (relative references resolve nowhere there)', async () => {
    const blend = path.join(rd, 'blobref.blend');
    await make(blend, textured('//blobtex.png'.replace('//', path.join(rd, '/'))));
    await expect(new BlendConverter({ stateDir: () => path.join(dir, 'real-state3') }).convert({ bytes: fs.readFileSync(blend) })).rejects.toMatchObject({ code: 'outside-refs' });
  }, 60_000);

  it('a Geometry Nodes import node (it reads any file) is refused, in a nested group too', async () => {
    const blend = path.join(rd, 'gn.blend');
    await make(blend, `
outer = bpy.data.node_groups.new('Outer', 'GeometryNodeTree')
inner = bpy.data.node_groups.new('Inner', 'GeometryNodeTree')
inner.nodes.new('GeometryNodeImportText')
g = outer.nodes.new('GeometryNodeGroup'); g.node_tree = inner
bpy.ops.mesh.primitive_cube_add()
bpy.ops.wm.save_as_mainfile(filepath=OUT)`);
    await expect(c().convert({ file: blend, base: rd })).rejects.toMatchObject({ status: 422, code: 'outside-refs', paths: [expect.stringContaining('GeometryNodeImportText')] });
  }, 60_000);

  it('--disable-autoexec holds: a startup script and a driver in the file do not run', async () => {
    const marker = path.join(outside, 'ran.txt');
    const blend = path.join(rd, 'auto.blend');
    await make(blend, `
t = bpy.data.texts.new('boot.py'); t.use_module = True
t.write(${JSON.stringify(`open(${JSON.stringify(marker)}, "w").write("x")`)})
bpy.ops.mesh.primitive_cube_add()
bpy.ops.wm.save_as_mainfile(filepath=OUT)`);
    // control: the marker script does run when autoexec is explicitly enabled
    const { execFileSync } = await import('node:child_process');
    execFileSync(real!, ['-b', '--factory-startup', '--enable-autoexec', blend], { stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    await c().convert({ file: blend, base: rd });
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  const tiled = (pattern: string) => `
bpy.ops.wm.save_as_mainfile(filepath=OUT) # saved first: a '//' path needs a place
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.active_object
mat = bpy.data.materials.new('M'); mat.use_nodes = True
tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
img = bpy.data.images.new('u', 4, 4, tiled=True)
img.filepath_raw = ${JSON.stringify(pattern)}
img.file_format = 'PNG'
img.save()
tex.image = img
mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
cube.data.materials.append(mat)
bpy.ops.wm.save_mainfile()`;

  it('a Geometry Nodes disk bake (it reads blob files by names from its own meta, ../ included) is refused; a packed one is not', async () => {
    const mk = (target: string) => `
bpy.ops.mesh.primitive_cube_add()
o = bpy.context.active_object
ng = bpy.data.node_groups.new('G', 'GeometryNodeTree')
ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
i = ng.nodes.new('NodeGroupInput'); out = ng.nodes.new('NodeGroupOutput'); b = ng.nodes.new('GeometryNodeBake')
ng.links.new(i.outputs[0], b.inputs[0]); ng.links.new(b.outputs[0], out.inputs[0])
m = o.modifiers.new('GN', 'NODES'); m.node_group = ng; m.bake_target = '${target}'
bpy.ops.wm.save_as_mainfile(filepath=OUT)`;
    const disk = path.join(rd, 'disk.blend');
    await make(disk, mk('DISK'));
    await expect(c().convert({ file: disk, base: rd })).rejects.toMatchObject({ status: 422, code: 'outside-refs', paths: [expect.stringContaining('disk bake')] });
    const packed = path.join(rd, 'packedbake.blend');
    await make(packed, mk('PACKED'));
    await expect(c().convert({ file: packed, base: rd })).resolves.toBeTruthy();
  }, 60_000);

  it('an external point cache is refused', async () => {
    const blend = path.join(rd, 'pc.blend');
    await make(blend, `
bpy.ops.mesh.primitive_cube_add()
o = bpy.context.active_object
m = o.modifiers.new('Cloth', 'CLOTH')
m.point_cache.use_external = True
bpy.ops.wm.save_as_mainfile(filepath=OUT)`);
    await expect(c().convert({ file: blend, base: rd })).rejects.toMatchObject({ code: 'outside-refs', paths: [expect.stringContaining('external point cache')] });
  }, 60_000);

  describe('a UDIM tile that is a symlink to a file outside the project', () => {
    let blend: string;
    let secret: Buffer;
    beforeAll(async () => {
      const dirT = path.join(rd, 'udim');
      fs.mkdirSync(dirT);
      blend = path.join(dirT, 'udim.blend');
      await make(blend, tiled('//tex.<UDIM>.png'));
      // an image no tile of the project holds: the bytes we look for in the GLB
      const png = path.join(outside, 'secret-tile.png');
      await make(path.join(outside, 'x.blend'), `img = bpy.data.images.new('s', 8, 8)\nimg.pixels = [0.123, 0.456, 0.789, 1.0] * 64\nimg.filepath_raw = ${JSON.stringify(png)}\nimg.file_format = 'PNG'\nimg.save()\nbpy.ops.wm.save_as_mainfile(filepath=OUT)`);
      secret = fs.readFileSync(png);
      fs.rmSync(path.join(dirT, 'tex.1001.png'), { force: true });
      fs.symlinkSync(png, path.join(dirT, 'tex.1001.png'));
    }, 60_000);
    const holds = (file: string) => fs.readFileSync(file).includes(secret);

    it('the static check refuses it', async () => {
      await expect(c().convert({ file: blend, base: rd })).rejects.toMatchObject({ code: 'outside-refs', paths: [expect.stringContaining('tex.1001.png')] });
    }, 60_000);

    it('without the static check it would leak (control), and the sandbox alone stops it', async () => {
      const open = await new BlendConverter({ stateDir: () => path.join(dir, 'real-sb0'), sandbox: false, skipStaticCheck: true }).convert({ file: blend, base: rd });
      expect(holds(open.glb)).toBe(true);
      const sb = new BlendConverter({ stateDir: () => path.join(dir, 'real-sb1'), sandbox: 'auto', skipStaticCheck: true });
      let leaked = false;
      try { leaked = holds((await sb.convert({ file: blend, base: rd })).glb); } catch { /* a failed export is fine too */ }
      expect(leaked).toBe(false);
    }, 90_000);
  });

  it.skipIf(process.platform !== 'darwin')('the sandbox denies reading outside the project and the network, whatever the file asks', async () => {
    const { execFileSync } = await import('node:child_process');
    const probe = path.join(dir, 'probe.py');
    const secretFile = path.join(outside, 'plain-secret.txt');
    fs.writeFileSync(secretFile, 'top secret');
    fs.writeFileSync(probe, `import socket\ntry:\n    print('READ', open(${JSON.stringify(secretFile)}).read())\nexcept Exception as e:\n    print('READ-DENIED')\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=3); print('NET-OK')\nexcept Exception as e:\n    print('NET-DENIED')\n`);
    const work = fs.mkdtempSync(path.join(dir, 'sbwork-'));
    const out = execFileSync('/usr/bin/sandbox-exec', ['-D', `SCRIPT=${probe}`, '-D', `ROOT=${rd}`, '-D', `WORK=${work}`, '-D', 'APP=/Applications/Blender.app', '-f', SANDBOX_PROFILE, real!, '-b', '--factory-startup', '--python', probe], { encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: work, HOME: work } });
    expect(out).toContain('READ-DENIED');
    expect(out).toContain('NET-DENIED');
    expect(out).not.toContain('top secret');
  }, 60_000);
});
