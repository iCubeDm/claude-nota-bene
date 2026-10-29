import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BlendConverter, findBlender, MAC_BLENDER } from './blend.ts';
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
fs.appendFileSync(log, JSON.stringify({ argv: a, cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n');
const out = a[a.indexOf('--') + 1];
if (body.startsWith('FAIL')) { console.error('line1\\nError: boom ' + body); process.exit(1); }
if (body.startsWith('HANG')) { if (body.includes('STUBBORN')) process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (body.startsWith('EMPTY')) process.exit(0);
else if (body.startsWith('SLOW')) setTimeout(() => { fs.writeFileSync(out, 'GLB:' + body); process.exit(0); }, 300);
else { fs.writeFileSync(out, 'GLB:' + body); process.exit(0); }
`;

let dir: string;
let fake: string;
let state: string;
const spawns = () => {
  try { return fs.readFileSync(path.join(path.dirname(fake), 'spawns.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string; env: string[] }); } catch { return []; }
};
const conv = (o: Partial<ConstructorParameters<typeof BlendConverter>[0]> = {}) =>
  new BlendConverter({ stateDir: () => state, blender: () => fake, ...o });

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
    const r = await c.convert({ file });
    expect(fs.readFileSync(r.glb, 'utf8')).toBe('GLB:cube');
    const s = spawns().slice(before);
    expect(s).toHaveLength(1);
    const argv = s[0]!.argv;
    expect(argv.slice(0, 3)).toEqual(['-b', '--disable-autoexec', '--factory-startup']);
    expect(argv[argv.indexOf('--python') + 1]).toMatch(/blend[\\/]export\.py$/);
    expect(argv.indexOf('--')).toBeGreaterThan(argv.indexOf('--python'));
    expect(argv.join(' ')).not.toContain('pwned'); // the file name never reaches Blender at all: it reads our copy
    expect(s[0]!.env).not.toContain('NB_TEST_SECRET');
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
    expect(r.glb).toBe(path.join(state, 'cache', 'blend', `${r.hash}-9.9.9.glb`));
    const again = await c.convert({ file });
    expect(again).toEqual(r);
    expect(spawns().slice(before)).toHaveLength(1);
    delete process.env.NB_TEST_SECRET;
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
    // the queue goes on after it
    await expect(c.convert({ bytes: Buffer.from('after') })).resolves.toBeTruthy();
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

  it('answers a failing export 422 and a missing Blender 501, as JSON', async () => {
    fs.writeFileSync(path.join(root, 'bad.blend'), 'FAIL route');
    const bad = await get('path=bad.blend');
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: 'export-failed', detail: expect.stringContaining('boom') });
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

// one test with the real Blender; skipped where there is none
const real = findBlender();
describe.skipIf(!real)('real Blender', () => {
  it('converts a .blend made by Blender itself to a glTF binary', async () => {
    const { execFileSync } = await import('node:child_process');
    const blend = path.join(dir, 'real.blend');
    const make = path.join(dir, 'make.py');
    fs.writeFileSync(make, 'import bpy, sys\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[sys.argv.index("--") + 1])\n');
    execFileSync(real!, ['-b', '--factory-startup', '--python', make, '--', blend], { stdio: 'ignore' });
    const r = await new BlendConverter({ stateDir: () => path.join(dir, 'real-state') }).convert({ file: blend });
    expect(fs.readFileSync(r.glb).subarray(0, 4).toString('latin1')).toBe('glTF');
  }, 60_000);
});
