import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { complete, fileRoutes } from './fileRoutes.ts';

let dir: string;
let root: string;
let server: http.Server;
let port: number;
const hub = new EventHub();
const allowedHosts: string[] = [];
const allowedOrigins: string[] = [];

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-routes-')));
  root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, '2.md'), '2');
  fs.writeFileSync(path.join(root, '10.md'), '10');
  fs.writeFileSync(path.join(root, 'hello.md'), 'abcdefghij');
  fs.writeFileSync(path.join(root, 'Отчёт #1.md'), 'ru');
  fs.writeFileSync(path.join(root, 'blob.bin'), 'zz');
  fs.writeFileSync(path.join(root, 'pic.png'), 'png');
  fs.writeFileSync(path.join(root, 'v.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(8 * 1024 * 1024));
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(dir, 'outside'), path.join(root, 'escape'));
  fs.symlinkSync(path.join(dir, 'nowhere'), path.join(root, 'dangling'));
  server = http.createServer(
    httpHandler({
      hub,
      webDist: dir,
      allowedHosts,
      allowedOrigins,
      info: () => ({}),
      extra: {
        ...fileRoutes({ root: () => root, hub, complete: async (q) => [q] }),
        '/attach': (_req, res) => res.end('ok'), // filled in M3-03
      },
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
  allowedOrigins.push(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

function req(method: string, p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      })
      .on('error', reject)
      .end();
  });
}

describe('/tree', () => {
  it('lists folders first, numeric order, no .git', async () => {
    const r = await req('GET', '/tree');
    expect(r.status).toBe(200);
    const names = JSON.parse(r.body).map((e: { name: string }) => e.name);
    expect(names.slice(0, 3)).toEqual(['sub', '2.md', '10.md']);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('dangling');
    expect(names).not.toContain('escape'); // a symlink out of the root is hidden, /file refuses it too
  });
  it('missing folder is 404 with [] as json; outside is 403', async () => {
    const r = await req('GET', '/tree?path=nope');
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.body).toBe('[]');
    expect((await req('GET', '/tree?path=..')).status).toBe(403);
  });
});

describe('/file', () => {
  it('serves whole with Accept-Ranges', async () => {
    const r = await req('GET', '/file?path=hello.md');
    expect(r.status).toBe(200);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toBe('abcdefghij');
  });
  it('Range gives 206 with the slice', async () => {
    const r = await req('GET', '/file?path=hello.md', { range: 'bytes=0-3' });
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-3/10');
    expect(r.body).toBe('abcd');
  });
  it('Range past the end is 416 and the server stays up', async () => {
    const r = await req('GET', '/file?path=hello.md', { range: 'bytes=10-' });
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */10');
    expect((await req('GET', '/file?path=hello.md')).status).toBe(200);
  });
  it('HEAD: 404 for missing, headers only for existing', async () => {
    expect((await req('HEAD', '/file?path=missing.md')).status).toBe(404);
    const r = await req('HEAD', '/file?path=hello.md');
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBe('10');
    expect(r.body).toBe('');
  });
  it('/file sends a weak ETag that changes when the file changes', async () => {
    const f = path.join(root, 'etag.txt');
    fs.writeFileSync(f, 'one');
    fs.utimesSync(f, 1_000_000, 1_000_000);
    const a = await req('GET', '/file?path=etag.txt');
    const st = fs.statSync(f);
    expect(a.headers.etag).toBe(`W/"${st.size}-${st.mtimeMs}"`);
    expect((await req('HEAD', '/file?path=etag.txt')).headers.etag).toBe(a.headers.etag);
    expect((await req('GET', '/file?path=etag.txt', { range: 'bytes=0-0' })).headers.etag).toBe(a.headers.etag);
    fs.writeFileSync(f, 'two');
    fs.utimesSync(f, 2_000_000, 2_000_000);
    const b = await req('HEAD', '/file?path=etag.txt');
    expect(b.headers.etag).toMatch(/^W\/"\d+-[\d.]+"$/);
    expect(b.headers.etag).not.toBe(a.headers.etag);
  });
  it('outside the root is 403 (decoded once)', async () => {
    expect((await req('GET', '/file?path=..%2Fx')).status).toBe(403);
    expect((await req('GET', '/file?path=%2Fetc%2Fpasswd')).status).toBe(403);
  });
  it('content types: octet-stream default, media table, Cyrillic name', async () => {
    expect((await req('GET', '/file?path=blob.bin')).headers['content-type']).toBe('application/octet-stream');
    expect((await req('GET', '/file?path=pic.png')).headers['content-type']).toBe('image/png');
    expect((await req('GET', '/file?path=' + encodeURIComponent('Отчёт #1.md'))).body).toBe('ru');
  });
  it('a directory is 404', async () => {
    expect((await req('GET', '/file?path=sub')).status).toBe(404);
  });
});

describe('complete()', () => {
  const sess = (f: (q: string) => Promise<string[]>) => ({ fileSuggestions: f });
  const many = Array.from({ length: 50 }, (_, i) => `f${i}.md`);
  it('uses the CLI hits when there are any, minus the query itself, in the CLI order', async () => {
    expect(await complete({ session: sess(async () => ['zz.md', 'a.md', 'ab']), root }, 'ab')).toEqual(['zz.md', 'a.md']);
  });
  it('falls back to the walk when the CLI throws or returns []', async () => {
    expect((await complete({ session: sess(async () => { throw new Error('x'); }), root }, 'hello'))[0]).toBe('hello.md');
    expect((await complete({ session: sess(async () => []), root }, 'hello'))[0]).toBe('hello.md');
  });
  it('an empty query gives the CLI relative hits, or []', async () => {
    expect(await complete({ session: sess(async () => []), root }, '')).toEqual([]);
    expect(await complete({ session: sess(async () => ['a.md', '/abs/out.md']), root }, '')).toEqual(['a.md']);
  });
  it('a CLI that returns only absolute outside paths still gives project files', async () => {
    const out = ['/Users/x/.claude/skills/hello/SKILL.md', '/Users/x/.claude/skills/b.md'];
    expect(await complete({ session: sess(async () => out), root }, 'hello')).toEqual(['hello.md']);
  });
  it('an absolute path inside the root becomes relative', async () => {
    const hits = await complete({ session: sess(async () => [path.join(root, 'sub', 'x.md'), path.join(root, 'sub') + '/']), root }, 'zzzq');
    expect(hits).toEqual(['sub/x.md', 'sub/']);
  });
  it('a new file the CLI does not know comes first, even when the CLI fills the page', async () => {
    const d = path.join(dir, 'fresh');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'report.md'), '');
    const cliHits = Array.from({ length: 30 }, (_, i) => `docs/r-e-p${i}.md`);
    const hits = await complete({ session: sess(async () => cliHits), root: d }, 'rep');
    expect(hits[0]).toBe('report.md');
    expect(hits).toHaveLength(30);
  });
  it('dedupes a folder returned with and without the trailing slash', async () => {
    const hits = await complete({ session: sess(async () => ['sub']), root }, 'sub');
    expect(hits.filter((p) => p.replace(/\/$/, '') === 'sub')).toEqual([]); // that is the query itself
    expect(new Set(hits).size).toBe(hits.length);
  });
  it('a CLI that never answers still gives our hits after the timeout', async () => {
    const t = Date.now();
    const hits = await complete({ session: sess(() => new Promise(() => {})), root, timeoutMs: 50 }, 'hello');
    expect(hits[0]).toBe('hello.md');
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('never returns more than 30', async () => {
    expect(await complete({ session: sess(async () => many), root }, 'f')).toHaveLength(30);
    const d = path.join(dir, 'many'); // fresh root: listFiles caches per root
    fs.mkdirSync(d);
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(d, `zz${i}.txt`), '');
    expect((await complete({ session: sess(async () => []), root: d }, 'zz')).length).toBe(30);
  });
});

describe('/complete and Origin', () => {
  it('/complete returns json from the injected function', async () => {
    expect(JSON.parse((await req('GET', '/complete?q=ab')).body)).toEqual(['ab']);
  });
  it('POST with a foreign or missing Origin is 403, with ours it reaches the route', async () => {
    const host = { host: `127.0.0.1:${port}` };
    expect((await req('POST', '/attach', { ...host, origin: 'http://evil.example' })).status).toBe(403);
    expect((await req('POST', '/attach', host)).status).toBe(403);
    expect((await req('POST', '/attach', { ...host, origin: `http://127.0.0.1:${port}` })).body).toBe('ok');
  });
});

describe('/file hardening', () => {
  it('symlink escape is 403 on /file and /tree', async () => {
    expect((await req('GET', '/file?path=escape/secret.txt')).status).toBe(403);
    expect((await req('GET', '/tree?path=escape')).status).toBe(403);
  });
  it('HEAD with Range is 206 without a body', async () => {
    const r = await req('HEAD', '/file?path=hello.md', { range: 'bytes=0-3' });
    expect(r.status).toBe(206);
    expect(r.headers['content-length']).toBe('4');
    expect(r.body).toBe('');
  });
  it('bytes=-0 is 416; NUL in the path is refused', async () => {
    expect((await req('GET', '/file?path=hello.md', { range: 'bytes=-0' })).status).toBe(416);
    const r = await req('GET', '/file?path=a%00b');
    expect([400, 403]).toContain(r.status);
  });
  it('sends nosniff, CSP sandbox and CORP on 200 and 206; svg keeps its type', async () => {
    for (const headers of [{}, { range: 'bytes=0-3' }] as Record<string, string>[]) {
      const r = await req('GET', '/file?path=v.svg', headers);
      expect(r.headers['content-type']).toBe('image/svg+xml');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toBe(
        "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      );
      expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
  });
  it('a read error is reported and the next request is served', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emit = vi.spyOn(hub, 'emit');
    const cs = vi.spyOn(fs, 'createReadStream').mockImplementationOnce((() =>
      new Readable({ read() { this.destroy(new Error('EIO boom')); } })) as unknown as typeof fs.createReadStream);
    await req('GET', '/file?path=hello.md').catch(() => {});
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'server-error', message: 'EIO boom' }), { store: false });
    cs.mockRestore();
    emit.mockRestore();
    spy.mockRestore();
    expect((await req('GET', '/file?path=hello.md')).body).toBe('abcdefghij');
  });
  it('an aborted request destroys the read stream (no fd leak)', async () => {
    const streams: fs.ReadStream[] = [];
    const real = fs.createReadStream;
    const cs = vi.spyOn(fs, 'createReadStream').mockImplementation(((...a: Parameters<typeof real>) => {
      const st = real(...a);
      streams.push(st);
      return st;
    }) as typeof fs.createReadStream);
    await new Promise<void>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/file?path=big.bin' }, (res) => {
        res.once('data', () => {
          r.destroy();
          resolve();
        });
      });
      r.on('error', () => {});
      r.end();
    });
    await vi.waitFor(() => expect(streams.length && streams.every((s) => s.destroyed)).toBe(true));
    cs.mockRestore();
  });
});
