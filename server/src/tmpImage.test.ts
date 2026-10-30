import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fileRoutes } from './fileRoutes.ts';
import { TMP_IMAGE_MAX, tmpDirs } from './tmpImage.ts';

let dir: string; // a fresh folder in the temp dir
let outside: string; // a folder outside every temp dir (under home)
let server: http.Server;
let port: number;
let prevHome: string | undefined;
const hub = new EventHub();
const allowedHosts: string[] = [];

type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
const get = (q: string, method = 'GET'): Promise<Res> =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: q, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
const img = (p: string, method?: string) => get(`/tmpimage?path=${encodeURIComponent(p)}`, method);

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tmpimg-')));
  outside = fs.mkdtempSync(path.join(os.homedir(), '.nb-tmpimg-test-'));
  prevHome = process.env.NOTA_BENE_HOME;
  process.env.NOTA_BENE_HOME = path.join(dir, 'state'); // the state folder sits inside a temp folder on purpose
  fs.mkdirSync(process.env.NOTA_BENE_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(process.env.NOTA_BENE_HOME, 'shot.png'), 'png-in-state');
  fs.writeFileSync(path.join(dir, 'a.png'), 'PNGDATA');
  fs.writeFileSync(path.join(dir, 'v.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'text');
  fs.writeFileSync(path.join(dir, 'noext'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.png'), 'outside-png');
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(dir, 'link-out.png'));
  fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(dir, 'link-key.png'));
  fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'link-txt.png')); // inside, but not an image
  fs.symlinkSync(path.join(dir, 'a.png'), path.join(dir, 'link-in.png')); // inside, an image: fine
  fs.symlinkSync(outside, path.join(dir, 'dirlink'));
  fs.symlinkSync(path.join(dir, 'nowhere.png'), path.join(dir, 'dangling.png'));
  execFileSync('mkfifo', [path.join(dir, 'pipe.png')]);
  fs.mkdirSync(path.join(dir, 'dir.png'));
  const big = fs.openSync(path.join(dir, 'big.png'), 'w');
  fs.ftruncateSync(big, TMP_IMAGE_MAX + 1); // sparse
  fs.closeSync(big);
  const edge = fs.openSync(path.join(dir, 'edge.png'), 'w');
  fs.ftruncateSync(edge, TMP_IMAGE_MAX);
  fs.closeSync(edge);
  server = http.createServer(
    httpHandler({
      hub, webDist: dir, allowedHosts, info: () => ({}),
      extra: fileRoutes({ root: () => path.join(dir, 'proj'), hub, complete: async () => [] }),
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME;
  else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('/tmpimage', () => {
  it('serves an image of a temp folder with its type and the safety headers; HEAD has no body', async () => {
    const r = await img(path.join(dir, 'a.png'));
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('PNGDATA');
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['content-length']).toBe('7');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toMatch(/^sandbox;/);
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    const h = await img(path.join(dir, 'a.png'), 'HEAD');
    expect([h.status, h.body.length, h.headers['content-length']]).toEqual([200, 0, '7']);
    expect((await img(path.join(dir, 'v.svg'))).headers['content-type']).toBe('image/svg+xml');
  });

  it('knows the temp folders: the real os.tmpdir(), /tmp and /private/tmp when they exist', () => {
    const dirs = tmpDirs();
    expect(dirs).toContain(fs.realpathSync.native(os.tmpdir()));
    if (fs.existsSync('/tmp')) expect(dirs).toContain(fs.realpathSync.native('/tmp'));
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('a symlink to an image inside the folder is fine; out of the folder, to a key file, to a non-image: refused alike', async () => {
    expect((await img(path.join(dir, 'link-in.png'))).status).toBe(200);
    const missing = await img(path.join(dir, 'nowhere.png'));
    for (const name of ['link-out.png', 'link-key.png', 'link-txt.png', 'dirlink/secret.png', 'dangling.png']) {
      const r = await img(path.join(dir, name));
      expect([name, r.status, r.body.toString()]).toEqual([name, 404, missing.body.toString()]);
    }
  });

  it('a real file with a non-image extension, a folder and the extension-less are refused; so is the sneaky `..`', async () => {
    for (const p of [path.join(dir, 'notes.txt'), path.join(dir, 'noext'), path.join(dir, 'dir.png'), dir]) expect((await img(p)).status, p).toBe(404);
    expect((await img(`${dir}/../${path.basename(dir)}/a.png`)).status).toBe(200); // `..` that stays inside resolves to the real file
    expect((await img(`${dir}/../../../../../../../${outside}/secret.png`)).status).toBe(404); // one that leaves the temp folders does not
  });

  it('a path outside the temp folders, a relative one, an empty one and a NUL are 404 with the body a missing file has', async () => {
    const missing = (await img(path.join(dir, 'nowhere.png'))).body.toString();
    for (const p of [path.join(outside, 'secret.png'), 'a.png', '', path.join(dir, 'a.png\0.txt'), path.join(dir, 'a\0.png')]) {
      const r = await img(p);
      expect([p, r.status, r.body.toString()]).toEqual([p, 404, missing]);
    }
    expect((await get('/tmpimage')).status).toBe(404);
  });

  it('the state folder is never served, even inside a temp folder', async () => {
    const r = await img(path.join(process.env.NOTA_BENE_HOME!, 'shot.png'));
    expect(r.status).toBe(404);
    expect(r.body.toString()).not.toContain('png-in-state');
    fs.symlinkSync(process.env.NOTA_BENE_HOME!, path.join(dir, 'state-link'));
    expect((await img(path.join(dir, 'state-link', 'shot.png'))).status).toBe(404);
  });

  it('a FIFO named like an image does not hang the server', async () => {
    const r = await Promise.race([img(path.join(dir, 'pipe.png')), new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
    expect(r?.status).toBe(404);
    expect((await img(path.join(dir, 'a.png'))).status).toBe(200); // still answering
  });

  it('the size cap: the cap itself is served (head), one byte more is 413', async () => {
    expect((await img(path.join(dir, 'big.png'), 'HEAD')).status).toBe(413);
    expect((await img(path.join(dir, 'big.png'))).status).toBe(413);
    const edge = await img(path.join(dir, 'edge.png'), 'HEAD');
    expect([edge.status, edge.headers['content-length']]).toEqual([200, String(TMP_IMAGE_MAX)]);
  });

  it('read-only: a write is refused before the route', async () => {
    const r = await get(`/tmpimage?path=${encodeURIComponent(path.join(dir, 'a.png'))}`, 'DELETE');
    expect(r.status).toBe(403); // no Origin on a write: the general guard answers first
  });
});
