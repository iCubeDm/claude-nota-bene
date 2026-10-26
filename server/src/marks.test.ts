import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { MARK_MAX_BYTES } from '@nota-bene/shared';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { MARK_ID, MarkFiles, markRoutes } from './marks.ts';

const ID = '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
const ID2 = '1f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

let dir: string;
let root: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-marks-')));
  root = path.join(dir, 'proj');
  fs.mkdirSync(root);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const marksDir = () => path.join(root, '.nota-bene', 'marks');
const media = (id: string): Comment => ({
  id, text: 'x', status: 'pending', createdAt: 1,
  anchor: { kind: 'media', source: { kind: 'file', path: 'a.png' }, width: 10, height: 10, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }] },
});
const text = (id: string): Comment => ({
  id, text: 'x', status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'file', path: 'a.md' }, start: 0, end: 1, quote: 'a', prefix: '', suffix: '' },
});

describe('MarkFiles', () => {
  it('MARK_ID is the uuid shape', () => {
    expect(MARK_ID.test(ID)).toBe(true);
    expect(MARK_ID.test(ID.slice(1))).toBe(false);
  });

  it('write creates the folder, the file and a self-ignoring .gitignore once', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
    const m = new MarkFiles({ root: () => root });
    m.write(ID, 'frame.jpg', JPEG);
    m.write(ID, 'layer.png', PNG);
    expect(fs.readFileSync(path.join(marksDir(), ID, 'frame.jpg'))).toEqual(JPEG);
    expect(fs.readFileSync(path.join(marksDir(), ID, 'layer.png'))).toEqual(PNG);
    expect(fs.readFileSync(path.join(root, '.nota-bene', '.gitignore'), 'utf8')).toBe('*\n');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules\n');
    expect(fs.readdirSync(path.join(marksDir(), ID)).sort()).toEqual(['frame.jpg', 'layer.png']); // no tmp left
    // an edited .gitignore is not rewritten
    fs.writeFileSync(path.join(root, '.nota-bene', '.gitignore'), '*\n!keep\n');
    m.write(ID2, 'frame.jpg', JPEG);
    expect(fs.readFileSync(path.join(root, '.nota-bene', '.gitignore'), 'utf8')).toBe('*\n!keep\n');
  });

  it('write overwrites an existing file', () => {
    const m = new MarkFiles({ root: () => root });
    m.write(ID, 'frame.jpg', JPEG);
    const next = Buffer.concat([JPEG, Buffer.from([9])]);
    m.write(ID, 'frame.jpg', next);
    expect(fs.readFileSync(path.join(marksDir(), ID, 'frame.jpg'))).toEqual(next);
  });

  describe('write refuses', () => {
    const m = () => new MarkFiles({ root: () => root });
    it('an id ../x', () => expect(() => m().write('../x', 'frame.jpg', JPEG)).toThrow());
    it('a 35-char id', () => expect(() => m().write(ID.slice(1), 'frame.jpg', JPEG)).toThrow());
    it('name x.png', () => expect(() => m().write(ID, 'x.png' as 'layer.png', PNG)).toThrow());
    it('bytes that are not the named type', () => {
      expect(() => m().write(ID, 'frame.jpg', PNG)).toThrow();
      expect(() => m().write(ID, 'layer.png', JPEG)).toThrow();
    });
    it('bytes over MARK_MAX_BYTES', () => {
      const big = Buffer.alloc(MARK_MAX_BYTES + 1);
      JPEG.copy(big);
      expect(() => m().write(ID, 'frame.jpg', big)).toThrow();
    });
    it('a symlinked .nota-bene: throws, and nothing is written outside', () => {
      const out = path.join(dir, 'outside');
      fs.mkdirSync(out);
      fs.symlinkSync(out, path.join(root, '.nota-bene'));
      expect(() => m().write(ID, 'frame.jpg', JPEG)).toThrow();
      expect(fs.readdirSync(out)).toEqual([]);
    });
    it('a symlinked marks folder', () => {
      const out = path.join(dir, 'outside');
      fs.mkdirSync(out);
      fs.mkdirSync(path.join(root, '.nota-bene'));
      fs.symlinkSync(out, marksDir());
      expect(() => m().write(ID, 'frame.jpg', JPEG)).toThrow();
      expect(fs.readdirSync(out)).toEqual([]);
    });
    it('a symlinked <id> folder', () => {
      const out = path.join(dir, 'outside');
      fs.mkdirSync(out);
      fs.mkdirSync(marksDir(), { recursive: true });
      fs.symlinkSync(out, path.join(marksDir(), ID));
      expect(() => m().write(ID, 'frame.jpg', JPEG)).toThrow();
      expect(fs.readdirSync(out)).toEqual([]);
    });
    it('a .nota-bene that is a file', () => {
      fs.writeFileSync(path.join(root, '.nota-bene'), 'x');
      expect(() => m().write(ID, 'frame.jpg', JPEG)).toThrow();
    });
  });

  it('sync removes only media comments that disappeared', () => {
    const m = new MarkFiles({ root: () => root });
    const gone = '2f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
    const noFolder = '3f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
    m.write(ID, 'frame.jpg', JPEG); // stays
    m.write(gone, 'frame.jpg', JPEG); // removed
    m.write(ID2, 'frame.jpg', JPEG); // a text comment with the same id shape: never touched
    m.sync([media(ID), media(gone), media(noFolder), text(ID2)], [media(ID)]);
    expect(fs.readdirSync(marksDir()).sort()).toEqual([ID, ID2].sort());
  });

  it('remove is idempotent', () => {
    const m = new MarkFiles({ root: () => root });
    m.write(ID, 'frame.jpg', JPEG);
    m.remove(ID);
    expect(fs.existsSync(path.join(marksDir(), ID))).toBe(false);
    expect(() => m.remove(ID)).not.toThrow();
    expect(() => new MarkFiles({ root: () => path.join(dir, 'none') }).remove(ID)).not.toThrow();
  });

  it('remove refuses a bad id and never follows a symlink', () => {
    const m = new MarkFiles({ root: () => root });
    expect(() => m.remove('../x')).toThrow();
    const out = path.join(dir, 'outside');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'keep'), 'k');
    fs.mkdirSync(marksDir(), { recursive: true });
    fs.symlinkSync(out, path.join(marksDir(), ID));
    expect(() => m.remove(ID)).toThrow();
    expect(fs.readdirSync(out)).toEqual(['keep']);
  });

  it('reads the root per call', () => {
    let r = root;
    const m = new MarkFiles({ root: () => r });
    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    r = other;
    m.write(ID, 'frame.jpg', JPEG);
    expect(fs.existsSync(path.join(other, '.nota-bene', 'marks', ID, 'frame.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.nota-bene'))).toBe(false);
  });
});

describe('mark routes', () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    const hosts: string[] = [];
    const origins: string[] = [];
    const hub = new EventHub();
    server = http.createServer(httpHandler({
      hub, webDist: dir, info: () => ({}), allowedHosts: hosts, allowedOrigins: origins,
      extra: markRoutes(new MarkFiles({ root: () => root }), hub),
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    hosts.push(`127.0.0.1:${port}`);
    origins.push(base);
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const post = (p: string, body: Buffer, type: string, origin: string | null = base) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': type, ...(origin ? { origin } : {}) }, body: new Uint8Array(body) });

  it('POST writes the file (204), DELETE removes the folder (204)', async () => {
    expect((await post(`/marks/${ID}/frame.jpg`, JPEG, 'image/jpeg')).status).toBe(204);
    expect((await post(`/marks/${ID}/layer.png`, PNG, 'image/png')).status).toBe(204);
    expect(fs.readFileSync(path.join(marksDir(), ID, 'frame.jpg'))).toEqual(JPEG);
    const d = await fetch(`${base}/marks/${ID}`, { method: 'DELETE', headers: { origin: base } });
    expect(d.status).toBe(204);
    expect(fs.existsSync(path.join(marksDir(), ID))).toBe(false);
  });

  it('refuses a type that does not match the name, bad names and ids, and bad bytes', async () => {
    expect((await post(`/marks/${ID}/frame.jpg`, JPEG, 'image/png')).status).toBe(415);
    expect((await post(`/marks/${ID}/layer.png`, PNG, 'image/jpeg')).status).toBe(415);
    expect((await post(`/marks/${ID}/x.png`, PNG, 'image/png')).status).toBe(404);
    expect((await post(`/marks/..%2F..%2Fx/frame.jpg`, JPEG, 'image/jpeg')).status).toBe(404);
    expect((await post(`/marks/${ID}/frame.jpg/extra`, JPEG, 'image/jpeg')).status).toBe(404);
    expect((await post(`/marks/${ID}/frame.jpg`, PNG, 'image/jpeg')).status).toBe(400);
    expect(fs.existsSync(path.join(root, '.nota-bene'))).toBe(false);
  });

  it('405 for other methods; 403 without an allowed Origin', async () => {
    expect((await fetch(`${base}/marks/${ID}/frame.jpg`)).status).toBe(405);
    expect((await fetch(`${base}/marks/${ID}`, { method: 'POST', headers: { origin: base } })).status).toBe(405);
    expect((await post(`/marks/${ID}/frame.jpg`, JPEG, 'image/jpeg', null)).status).toBe(403);
    expect((await post(`/marks/${ID}/frame.jpg`, JPEG, 'image/jpeg', 'http://evil.example')).status).toBe(403);
    expect((await fetch(`${base}/marks/${ID}`, { method: 'DELETE' })).status).toBe(403);
    expect(fs.existsSync(path.join(root, '.nota-bene'))).toBe(false);
  });

  it('413 above MARK_MAX_BYTES', async () => {
    const big = Buffer.alloc(MARK_MAX_BYTES + 1);
    JPEG.copy(big);
    expect((await post(`/marks/${ID}/frame.jpg`, big, 'image/jpeg')).status).toBe(413);
  });

  it('a symlinked .nota-bene gives 500 and nothing outside', async () => {
    const out = path.join(dir, 'outside');
    fs.mkdirSync(out);
    fs.symlinkSync(out, path.join(root, '.nota-bene'));
    expect((await post(`/marks/${ID}/frame.jpg`, JPEG, 'image/jpeg')).status).toBe(500);
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
