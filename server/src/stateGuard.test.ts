import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeBackend } from './agent/fake.ts';
import { accessToken } from './auth.ts';
import { clearSourceCache } from './git.ts';
import { startServer } from './server.ts';

// B1: a window whose root contains the state folder must not serve, list or search the access token, by any route or source.

let tmp: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];
const GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, ...GIT }, stdio: 'pipe' });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-state-')));
  fs.mkdirSync(path.join(tmp, 'dist'));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), 'x');
  clearSourceCache();
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function boot(root: string) {
  const s = await startServer({ insecureNoAuth: true, cwd: root, port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist') });
  closers.push(s.close);
  return s.url;
}
const get = (url: string, p: string) => fetch(`${url}${p}`);
const q = (s: string) => encodeURIComponent(s);

describe('a root that contains the state folder', () => {
  it('serves, lists and finds the project, but never anything in the state folder (live files)', async () => {
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    process.env.NOTA_BENE_HOME = path.join(proj, '.my-state');
    const token = accessToken();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'project file');
    fs.symlinkSync(path.join(proj, '.my-state'), path.join(proj, 'link-to-state')); // a symlink inside the project
    fs.symlinkSync(path.join(proj, '.my-state', 'token'), path.join(proj, 'link-to-token'));
    const url = await boot(proj);
    expect(await (await get(url, '/file?path=a.txt')).text()).toBe('project file');
    for (const p of ['.my-state/token', '.my-state/', 'link-to-state/token', 'link-to-token', '.my-state/../.my-state/token', '.my-state/nope']) {
      const r = await get(url, `/file?path=${q(p)}`);
      expect([p, r.status]).toEqual([p, 403]);
      expect(await r.text()).not.toContain(token);
      expect((await get(url, `/file?path=${q(p)}`)).headers.get('range')).toBeNull();
    }
    expect((await fetch(`${url}/file?path=${q('.my-state/token')}`, { headers: { range: 'bytes=0-9' } })).status).toBe(403);
    expect((await fetch(`${url}/file?path=${q('.my-state/token')}`, { method: 'HEAD' })).status).toBe(403);
    const tree = (await (await get(url, '/tree?path=')).json()) as { name: string }[];
    expect(tree.map((e) => e.name)).toEqual(['a.txt']); // neither the folder nor the symlinks into it
    expect((await get(url, `/tree?path=${q('.my-state')}`)).status).toBe(403);
    expect((await get(url, `/tree?path=${q('link-to-state')}`)).status).toBe(403);
    const hits = (await (await get(url, '/complete?q=token')).json()) as string[];
    expect(hits.join('\n')).not.toMatch(/my-state|link-to-/);
    expect((await get(url, '/complete?q=a.txt')).status).toBe(200);
    expect(JSON.stringify(await (await get(url, '/complete?q=my')).json())).not.toContain('my-state');
  });

  it('a root of $HOME-like shape: the state folder is a child of the root, under its default name', async () => {
    const proj = path.join(tmp, 'home');
    fs.mkdirSync(proj);
    process.env.NOTA_BENE_HOME = path.join(proj, '.nota-bene');
    accessToken();
    fs.writeFileSync(path.join(proj, 'readme.md'), 'hi');
    const url = await boot(proj);
    expect(((await (await get(url, '/tree?path=')).json()) as { name: string }[]).map((e) => e.name)).toEqual(['readme.md']);
    expect((await get(url, `/file?path=${q('.nota-bene/token')}`)).status).toBe(403);
  });

  it('branches and worktrees (src=): blobs and live worktree folders refuse the state folder too', async () => {
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    git(proj, 'init', '-q', '-b', 'main');
    process.env.NOTA_BENE_HOME = path.join(proj, '.my-state');
    const token = accessToken();
    fs.writeFileSync(path.join(proj, 'a.txt'), 'project file');
    git(proj, 'add', '-f', '-A');
    git(proj, 'commit', '-q', '-m', 'one'); // the token is committed (a repo that tracks its state folder)
    git(proj, 'branch', 'feature');
    git(proj, 'checkout', '-q', '-b', 'work');
    const url = await boot(proj);
    // a branch served from blobs
    const src = q('ref:feature');
    expect(await (await get(url, `/file?src=${src}&path=a.txt`)).text()).toBe('project file');
    for (const p of ['.my-state/token', '.my-state']) {
      const r = await get(url, `/file?src=${src}&path=${q(p)}`);
      expect([p, r.status]).toEqual([p, 403]);
      expect(await r.text()).not.toContain(token);
    }
    expect((await fetch(`${url}/file?src=${src}&path=${q('.my-state/token')}`, { method: 'HEAD' })).status).toBe(403);
    expect(((await (await get(url, `/tree?src=${src}&path=`)).json()) as { name: string }[]).map((e) => e.name)).toEqual(['a.txt']);
    expect((await get(url, `/tree?src=${src}&path=${q('.my-state')}`)).status).toBe(403);
    expect(JSON.stringify(await (await get(url, `/complete?src=${src}&q=token`)).json())).not.toContain('my-state');
    // the same branch, now live in a linked worktree that CONTAINS the state folder (the review's case)
    const wt = path.join(tmp, 'wt');
    git(proj, 'worktree', 'add', '-q', wt, 'feature');
    process.env.NOTA_BENE_HOME = path.join(wt, '.wt-state');
    const wtToken = accessToken();
    clearSourceCache();
    const url2 = await boot(proj);
    expect(await (await get(url2, `/file?src=${src}&path=a.txt`)).text()).toBe('project file');
    const r = await get(url2, `/file?src=${src}&path=${q('.wt-state/token')}`);
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain(wtToken);
    expect(((await (await get(url2, `/tree?src=${src}&path=`)).json()) as { name: string }[]).map((e) => e.name)).not.toContain('.wt-state');
    expect((await get(url2, `/tree?src=${src}&path=${q('.wt-state')}`)).status).toBe(403);
    expect(JSON.stringify(await (await get(url2, `/complete?src=${src}&q=token`)).json())).not.toContain('wt-state');
  });

  it('a state folder outside the root changes nothing', async () => {
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(proj);
    process.env.NOTA_BENE_HOME = path.join(tmp, 'elsewhere');
    accessToken();
    fs.writeFileSync(path.join(proj, '.hidden-ok'), 'visible');
    const url = await boot(proj);
    expect(await (await get(url, `/file?path=${q('.hidden-ok')}`)).text()).toBe('visible');
    expect(((await (await get(url, '/tree?path=')).json()) as { name: string }[]).map((e) => e.name)).toEqual(['.hidden-ok']);
  });
});
