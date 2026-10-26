import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { fileRoutes } from './fileRoutes.ts';
import { clearSourceCache, limits, listSources, readFile, readTree, type Source } from './git.ts';

// a main checkout on `main`, a worktree on `feature/x`, a detached worktree, branches `old` and `team/notes` without a
// worktree, and `gone/wt` whose worktree folder was deleted (prunable)
let dir: string;
let root: string;
let wt: string;
let wtd: string;
let plainDir: string;
let server: http.Server;
let port: number;
const hub = new EventHub();
const allowedHosts: string[] = [];

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' }).toString();
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-git-')));
  root = path.join(dir, 'main');
  wt = path.join(dir, 'wt-x');
  plainDir = path.join(dir, 'plain');
  fs.mkdirSync(plainDir);
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  write(path.join(root, 'a.md'), 'main a');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  git(root, 'checkout', '-qb', 'old');
  write(path.join(root, 'old-only.md'), 'from old');
  write(path.join(root, 'olddir/inner.txt'), 'inner');
  write(path.join(root, ':x.md'), 'colon');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'old');
  git(root, 'checkout', '-q', 'main');
  git(root, 'checkout', '-qb', 'team/notes');
  write(path.join(root, 'Заметки #1.md'), 'ру');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'notes');
  git(root, 'checkout', '-q', 'main');
  git(root, 'worktree', 'add', '-q', '-b', 'feature/x', wt);
  wtd = path.join(dir, 'wt-d');
  git(root, 'worktree', 'add', '-q', '--detach', wtd);
  git(root, 'worktree', 'add', '-q', '-b', 'gone/wt', path.join(dir, 'wt-gone'));
  fs.rmSync(path.join(dir, 'wt-gone'), { recursive: true, force: true }); // prunable, not pruned
  write(path.join(wt, 'only-x.md'), 'only in x');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
  server = http.createServer(
    httpHandler({
      hub, webDist: dir, allowedHosts, allowedOrigins: [], info: () => ({}),
      extra: fileRoutes({ root: () => root, hub, complete: async (q) => [q] }),
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`);
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

const byId = async (id: string): Promise<Source> => (await listSources(root)).find((s) => s.id === id)!;

describe('listSources', () => {
  it('stable ids: here, ref:<branch> served from its live worktree or from blobs, dir:<hash> for a detached worktree', async () => {
    clearSourceCache();
    const list = await listSources(root);
    expect(list.map((s) => [s.id.replace(/^dir:[0-9a-f]{12}$/, 'dir:HASH'), s.kind, s.ref])).toEqual([
      ['here', 'checkout', 'main'],
      ['dir:HASH', 'worktree', '(detached) wt-d'],
      ['ref:feature/x', 'worktree', 'feature/x'],
      ['ref:gone/wt', 'branch', 'gone/wt'], // its worktree folder is gone: the branch serves from blobs
      ['ref:old', 'branch', 'old'],
      ['ref:team/notes', 'branch', 'team/notes'],
    ]);
    expect(list.find((s) => s.id === 'ref:feature/x')!.dir).toBe(wt);
    expect(list.find((s) => s.id === 'ref:old')!.dir).toBeUndefined();
    expect(list[0].dir).toBe(root);
    expect(list[1].dir).toBe(wtd);
  });
  it('a prunable worktree does not hide its branch', async () => {
    const gone = await byId('ref:gone/wt');
    expect((await readFile(root, gone, 'a.md'))?.toString()).toBe('main a');
  });
  it('the window checkout is `here` whatever form its path takes (compared by realpath)', async () => {
    clearSourceCache();
    const viaDots = path.join(dir, 'wt-x', '..', 'main');
    expect((await listSources(viaDots))[0].dir).toBe(root); // realpath
    expect((await listSources(viaDots)).filter((s) => s.kind === 'worktree').map((s) => s.ref)).toEqual(['(detached) wt-d', 'feature/x']);
  });
  it('a folder that is not a git repo has only `here`', async () => {
    expect((await listSources(plainDir)).map((s) => s.id)).toEqual(['here']);
  });
});

describe('readTree / readFile', () => {
  it('a branch gives its committed content, absent from the working tree', async () => {
    const old = await byId('ref:old');
    expect(fs.existsSync(path.join(root, 'old-only.md'))).toBe(false);
    expect((await readTree(root, old, '')).map((e) => [e.name, e.dir])).toEqual([['olddir', true], [':x.md', false], ['a.md', false], ['old-only.md', false]]);
    expect((await readTree(root, old, 'olddir')).map((e) => e.name)).toEqual(['inner.txt']);
    expect((await readFile(root, old, 'old-only.md'))?.toString()).toBe('from old');
    expect(await readFile(root, old, 'nope.md')).toBeNull();
    await expect(readTree(root, old, 'nope')).rejects.toThrow();
  });
  it('a worktree reads its own folder', async () => {
    const x = await byId('ref:feature/x');
    expect((await readTree(root, x, '')).map((e) => e.name)).toContain('only-x.md');
    expect((await readFile(root, x, 'only-x.md'))?.toString()).toBe('only in x');
  });
  it('a branch name with / and a Cyrillic file name', async () => {
    const notes = await byId('ref:team/notes');
    expect((await readTree(root, notes, '')).map((e) => e.name)).toContain('Заметки #1.md');
    expect((await readFile(root, notes, 'Заметки #1.md'))?.toString()).toBe('ру');
  });
  it('a branch path that climbs out, or has NUL, \\ or a leading /, is refused with 403', async () => {
    const old = await byId('ref:old');
    await expect(readFile(root, old, '../secret.txt')).rejects.toMatchObject({ status: 403 });
    await expect(readTree(root, old, '..')).rejects.toMatchObject({ status: 403 });
    for (const bad of ['a\0.md', 'olddir\\inner.txt', '/etc/passwd']) await expect(readFile(root, old, bad)).rejects.toMatchObject({ status: 403 });
  });
  it('pathspec magic is literal: `:x.md` opens, `:(top)a.md` is just a missing name', async () => {
    const old = await byId('ref:old');
    expect((await readFile(root, old, ':x.md'))?.toString()).toBe('colon');
    expect(await readFile(root, old, ':(top)a.md')).toBeNull();
  });
});

describe('routes with src', () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  it('GET /sources returns the list', async () => {
    const r = await req('GET', '/sources');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).map((s: Source) => s.id.replace(/^dir:.*/, 'dir:'))).toEqual(['here', 'dir:', 'ref:feature/x', 'ref:gone/wt', 'ref:old', 'ref:team/notes']);
  });
  it('an unknown src is 400; a raw path as src too', async () => {
    expect((await req('GET', `/tree?${q({ src: 'ref:nope' })}`)).status).toBe(400);
    expect((await req('GET', `/file?${q({ src: wt, path: 'a.md' })}`)).status).toBe(400);
    expect((await req('GET', `/file?${q({ src: 'ref:main', path: 'a.md' })}`)).status).toBe(400); // checked out: not a branch source
    expect((await req('GET', `/complete?${q({ src: 'nope', q: 'a' })}`)).status).toBe(400);
  });
  it('a worktree: tree, file with Range, and ../ is 403', async () => {
    const t = await req('GET', `/tree?${q({ src: 'ref:feature/x' })}`);
    expect(JSON.parse(t.body).map((e: { name: string }) => e.name)).toContain('only-x.md');
    const f = await req('GET', `/file?${q({ src: 'ref:feature/x', path: 'only-x.md' })}`, { range: 'bytes=0-3' });
    expect(f.status).toBe(206);
    expect(f.body).toBe('only');
    expect(f.headers['content-security-policy']).toContain('sandbox');
    expect((await req('GET', `/file?${q({ src: 'ref:feature/x', path: '../x' })}`)).status).toBe(403);
    expect((await req('GET', `/tree?${q({ src: 'ref:feature/x', path: '..' })}`)).status).toBe(403);
  });
  it('a branch: the blob with Range (206), safety headers, HEAD gives the length, missing is 404', async () => {
    const p = `/file?${q({ src: 'ref:team/notes', path: 'Заметки #1.md' })}`;
    const f = await req('GET', p, { range: 'bytes=0-1' });
    expect(f.status).toBe(206);
    expect(f.headers['content-range']).toBe(`bytes 0-1/${Buffer.byteLength('ру')}`);
    expect(f.headers['content-length']).toBe('2');
    expect(f.body).toBe('\u0440'); // the first two bytes are one Cyrillic letter
    expect(f.headers['content-type']).toContain('text/plain');
    expect(f.headers['x-content-type-options']).toBe('nosniff');
    expect(f.headers['content-security-policy']).toContain('sandbox');
    expect(f.headers['accept-ranges']).toBe('bytes');
    const whole = await req('GET', p);
    expect(whole.status).toBe(200);
    expect(whole.body).toBe('ру');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    const tail = await req('GET', p, { range: 'bytes=-2' });
    expect(tail.status).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes 2-3/4`);
    const past = await req('GET', p, { range: 'bytes=4-' });
    expect(past.status).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */4');
    const h = await req('HEAD', p);
    expect(h.status).toBe(200);
    expect(h.headers['content-length']).toBe(String(Buffer.byteLength('ру')));
    expect(h.body).toBe('');
    expect((await req('HEAD', `/file?${q({ src: 'ref:old', path: 'nope.md' })}`)).status).toBe(404);
    expect((await req('GET', `/file?${q({ src: 'ref:old', path: '../secret.txt' })}`)).status).toBe(403);
    const t = await req('GET', `/tree?${q({ src: 'ref:old', path: 'olddir' })}`);
    expect(JSON.parse(t.body)).toEqual([{ name: 'inner.txt', dir: false }]);
    expect((await req('GET', `/tree?${q({ src: 'ref:old', path: 'nope' })}`)).status).toBe(404);
  });
  it('pathspec magic over HTTP: `:(top)a.md` is 404, never 500; `:x.md` is served', async () => {
    expect((await req('GET', `/file?${q({ src: 'ref:old', path: ':(top)a.md' })}`)).status).toBe(404);
    expect((await req('HEAD', `/file?${q({ src: 'ref:old', path: ':(top)a.md' })}`)).status).toBe(404);
    expect((await req('GET', `/tree?${q({ src: 'ref:old', path: ':(top)' })}`)).status).toBe(404);
    expect((await req('GET', `/file?${q({ src: 'ref:old', path: ':x.md' })}`)).body).toBe('colon');
  });
  it('a blob over the cap is 413 for GET and HEAD', async () => {
    const was = limits.blobMax;
    limits.blobMax = 4;
    try {
      expect((await req('GET', `/file?${q({ src: 'ref:old', path: 'old-only.md' })}`)).status).toBe(413);
      expect((await req('HEAD', `/file?${q({ src: 'ref:old', path: 'old-only.md' })}`)).status).toBe(413);
      expect((await req('GET', `/file?${q({ src: 'ref:old', path: ':x.md' })}`)).status).toBe(413);
    } finally {
      limits.blobMax = was;
    }
  });
  it('/complete searches the chosen source', async () => {
    const w = await req('GET', `/complete?${q({ src: 'ref:feature/x', q: 'only' })}`);
    expect(JSON.parse(w.body)).toContain('only-x.md');
    const b = await req('GET', `/complete?${q({ src: 'ref:old', q: 'inner' })}`);
    expect(JSON.parse(b.body)).toContain('olddir/inner.txt');
  });
});
