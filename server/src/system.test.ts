import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeBackend } from './agent/fake.ts';
import { readPrefs } from './prefs.ts';
import { startServer } from './server.ts';
import { CLEAN_MIN_AGE_MS, CONTROL_HEADER, cleanAttachments, cleanCandidates, controlToken, dirSize } from './system.ts';
import { registerWindow } from './windows.ts';

let home: string;
let dist: string;
let proj: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-dist-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-proj-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  for (const d of [home, dist, proj]) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(cwd = proj) {
  const exits: number[] = [];
  const s = await startServer({ cwd, port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, exit: (c) => void exits.push(c) });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  return { ...s, port, exits, origin: s.url };
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const id = (c: string) => c.repeat(64);
function attachment(name: string, bytes: number, ageMs: number) {
  const dir = path.join(home, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(bytes));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(f, t, t);
}

describe('control token', () => {
  it('is created once, 64 hex, mode 600, and reused', () => {
    const t = controlToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(controlToken()).toBe(t);
    expect(fs.statSync(path.join(home, 'control-token')).mode & 0o777).toBe(0o600);
  });
  it('a garbage token file is replaced', () => {
    fs.writeFileSync(path.join(home, 'control-token'), 'nope');
    expect(controlToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('storage', () => {
  it('dirSize counts files recursively and never follows a symlink', () => {
    fs.mkdirSync(path.join(proj, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'a', 'x'), 'abc');
    fs.writeFileSync(path.join(proj, 'a', 'b', 'y'), 'de');
    fs.symlinkSync(os.homedir(), path.join(proj, 'a', 'link'));
    expect(dirSize(path.join(proj, 'a'))).toEqual({ bytes: 5, files: 2 });
    expect(dirSize(path.join(proj, 'missing'))).toEqual({ bytes: 0, files: 0 });
  });

  it('clean takes only unreferenced attachments older than a day, and moves them to the trash', () => {
    const old = CLEAN_MIN_AGE_MS + 60_000;
    attachment(`${id('a')}.png`, 10, old); // referenced by a comment: kept
    attachment(`${id('b')}.png`, 20, old); // unreferenced, old: taken
    attachment(`${id('c')}.jpg`, 30, 1000); // unreferenced, fresh (a draft may hold it): kept
    attachment('notes.txt', 5, old); // not an attachment name: never touched
    fs.mkdirSync(path.join(home, 'comments'), { recursive: true });
    fs.writeFileSync(path.join(home, 'comments', 's1.json'), JSON.stringify([{ id: 'c1', images: [id('a')] }]));
    expect(cleanCandidates()).toEqual({ files: [`${id('b')}.png`], bytes: 20 });
    const r = cleanAttachments();
    expect(r).toMatchObject({ moved: 1, bytes: 20 });
    expect(r.trash.startsWith(path.join(home, 'trash', 'attachments'))).toBe(true);
    expect(fs.existsSync(path.join(r.trash, `${id('b')}.png`))).toBe(true);
    expect(fs.readdirSync(path.join(home, 'attachments')).sort()).toEqual([`${id('a')}.png`, `${id('c')}.jpg`, 'notes.txt']);
  });

  it('GET /system/storage reports sizes, the project marks and the clean count; POST clean moves', async () => {
    attachment(`${id('b')}.png`, 20, CLEAN_MIN_AGE_MS + 60_000);
    fs.mkdirSync(path.join(proj, '.nota-bene', 'marks', 'm1'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.nota-bene', 'marks', 'm1', 'layer.png'), 'xyz');
    const s = await boot();
    const st = await (await fetch(`${s.url}/system/storage`)).json() as Record<string, { bytes: number; files: number }>;
    expect(st.attachments).toEqual({ bytes: 20, files: 1 });
    expect(st.marks).toMatchObject({ bytes: 3, files: 1 });
    expect(st.unreferenced).toEqual({ bytes: 20, files: 1 });
    expect((await post(`${s.url}/system/storage/clean`, {})).status).toBe(403); // no Origin
    const r = await post(`${s.url}/system/storage/clean`, {}, { origin: s.origin });
    expect(await r.json()).toMatchObject({ moved: 1, bytes: 20 });
  });
});

describe('defaults and about', () => {
  it('the default mode is stored and validated', async () => {
    const s = await boot();
    expect(await (await fetch(`${s.url}/system/prefs`)).json()).toEqual({ defaultMode: 'auto' });
    expect((await post(`${s.url}/system/prefs`, { defaultMode: 'bogus' }, { origin: s.origin })).status).toBe(400);
    expect((await post(`${s.url}/system/prefs`, { defaultMode: 'plan' }, { origin: s.origin })).status).toBe(200);
    expect(readPrefs().defaultMode).toBe('plan');
    // a project with no mode of its own starts in the default
    const fresh = await boot(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-fresh-')));
    const ws = new WebSocket(fresh.url.replace('http', 'ws'));
    closers.push(async () => void ws.terminate());
    const mode = await new Promise<string>((res) => ws.on('message', (d) => {
      const e = JSON.parse(String(d)) as { kind: string; mode?: string };
      if (e.kind === 'mode') res(e.mode!);
    }));
    expect(mode).toBe('plan');
  });

  it('about names the version, the state dir and the node version', async () => {
    const s = await boot();
    const a = await (await fetch(`${s.url}/system/about`)).json() as { version: string; stateDir: string; node: string };
    expect(a.stateDir).toBe(home);
    expect(a.version.length).toBeGreaterThan(0);
    expect(a.node).toBe(process.version);
  });
});

describe('windows', () => {
  it('lists registered windows with their state; /info carries busy and clients', async () => {
    const a = await boot();
    const b = await boot(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-b-')));
    const bRoot = ((await (await fetch(`${b.url}/info`)).json()) as { root: string; busy: boolean; clients: number });
    expect(bRoot).toMatchObject({ busy: false, clients: 0 });
    registerWindow(a.port, ((await (await fetch(`${a.url}/info`)).json()) as { root: string }).root, process.pid);
    registerWindow(b.port, bRoot.root, process.pid);
    registerWindow(1, '/gone', 999_999_999); // a dead pid
    const rows = await (await fetch(`${a.url}/system/windows`)).json() as { port: number; state: string; current: boolean }[];
    expect(rows.map((r) => [r.port, r.state, r.current])).toEqual([[1, 'stale', false], ...[[a.port, 'live', true], [b.port, 'live', false]].sort((x, y) => (x[0] as number) - (y[0] as number))]);
  });

  it('A stops B through B\'s /control with the token; A refuses to act on itself; a page never reaches /control', async () => {
    const a = await boot();
    const b = await boot(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-b-')));
    for (const s of [a, b]) registerWindow(s.port, ((await (await fetch(`${s.url}/info`)).json()) as { root: string }).root, process.pid);
    // a page (with an Origin, even its own) is refused at /control, with or without the token
    expect((await post(`${b.url}/control/stop`, {}, { origin: b.origin })).status).toBe(403);
    expect((await post(`${b.url}/control/stop`, {}, { origin: b.origin, [CONTROL_HEADER]: controlToken() })).status).toBe(403);
    // no token, or a wrong one: refused
    expect((await post(`${b.url}/control/stop`, {})).status).toBe(403);
    expect((await post(`${b.url}/control/stop`, {}, { [CONTROL_HEADER]: 'f'.repeat(64) })).status).toBe(403);
    // A's own window and bad input
    expect((await post(`${a.url}/system/windows/action`, { port: a.port, action: 'stop' }, { origin: a.origin })).status).toBe(409);
    expect((await post(`${a.url}/system/windows/action`, { port: b.port, action: 'rm -rf' }, { origin: a.origin })).status).toBe(400);
    expect((await post(`${a.url}/system/windows/action`, { port: 2, action: 'stop' }, { origin: a.origin })).status).toBe(404);
    // restart-server on an unsupervised window: B says 409, A reports it
    const rs = await post(`${a.url}/system/windows/action`, { port: b.port, action: 'restart-server' }, { origin: a.origin });
    expect(await rs.json()).toEqual({ status: 409 });
    expect(b.exits).toEqual([]);
    // the real thing: B exits with 0 (the launcher's "stop")
    const r = await post(`${a.url}/system/windows/action`, { port: b.port, action: 'stop' }, { origin: a.origin });
    expect(r.status).toBe(200);
    await until(() => b.exits.length > 0);
    expect(b.exits).toEqual([0]);
    expect(a.exits).toEqual([]);
  });

  it('a registered port that answers with another root gets no token', async () => {
    const a = await boot();
    const b = await boot(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-system-b-')));
    registerWindow(b.port, '/some/other/root', process.pid); // the port was reused by another window/app
    const r = await post(`${a.url}/system/windows/action`, { port: b.port, action: 'stop' }, { origin: a.origin });
    expect(r.status).toBe(409);
    await new Promise((res) => setTimeout(res, 150));
    expect(b.exits).toEqual([]);
  });
});
