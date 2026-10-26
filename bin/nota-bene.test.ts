// Spawns the real launcher (bin/nota-bene.mjs) with the fake agent, a temp NOTA_BENE_HOME and ports 4791-4795.
// Every launcher runs in its own process group; afterEach SIGKILLs the groups, so no server outlives a test.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM, no types
import { buildLock, ensureBuild, needsBuild, portFree } from './nota-bene.mjs';

const BIN = fileURLToPath(new URL('./nota-bene.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('../server/test/fixtures/hello.json', import.meta.url));

let tmp: string;
let home: string;
let project: string;
const groups = new Set<number>();
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-bin-')));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
});

afterEach(async () => {
  // the detached (--detach) launcher has a group of its own: find it through the registry
  for (const w of Object.values(windows())) {
    if (w.launcherPid) groups.add(w.launcherPid);
    groups.add(w.pid);
  }
  for (const g of groups) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      try {
        process.kill(g, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  groups.clear();
  for (const sock of sockets) sock.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Win = { root: string; pid: number; launcherPid?: number; startedAt: number };
function windows(): Record<string, Win> {
  const out: Record<string, Win> = {};
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(home, 'windows'));
  } catch {
    return out;
  }
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    try {
      out[m[1]!] = JSON.parse(fs.readFileSync(path.join(home, 'windows', n), 'utf8'));
    } catch {
      // mid-write: absent this round
    }
  }
  return out;
}

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  NOTA_BENE_HOME: home,
  NOTA_BENE_BUILD_CMD: 'true', // never run the real vite build from a test
  CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
  TMPDIR: tmp, // the --detach log and the build lock stay out of the real TMPDIR
  ...extra,
});

type Run = { p: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> };
function launch(args: string[], extra: Record<string, string> = {}, fake = FAKE): Run {
  const p = spawn(process.execPath, [BIN, project, ...args, '--fake', fake, '--no-open'], {
    env: env(extra),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  groups.add(p.pid!);
  let out = '';
  let err = '';
  p.stdout!.on('data', (d) => (out += d));
  p.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
  return { p, out: () => out, err: () => err, exited };
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function hold(port: number, host = '127.0.0.1'): Promise<void> {
  // a port holder that never answers; afterEach destroys its sockets (a probe's open connection would hang close)
  const s = net.createServer((sock) => {
    sock.on('error', () => {});
    sockets.add(sock);
  });
  await new Promise<void>((r) => s.listen(port, host, () => r()));
  servers.push(s);
}

async function firstFree(from: number, to: number): Promise<number> {
  for (let p = from; p <= to; p++) if (await portFree(p)) return p;
  throw new Error(`no free port in ${from}-${to}`);
}

async function info(port: number): Promise<{ root: string; supervised: boolean } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(500) });
    return r.ok ? ((await r.json()) as { root: string; supervised: boolean }) : null;
  } catch {
    return null;
  }
}

const argsOf = (pid: number) => execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const bin = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { env: env(extra), encoding: 'utf8', timeout: 10000 });

describe('nota-bene launcher', () => {
  it('starts, /info answers supervised, the registry has the entry with both pids; --find reports it', async () => {
    const r = launch(['--port', '4791']);
    const w = await waitFor(() => windows()['4791']);
    expect(w.root).toBe(project);
    expect(w.launcherPid).toBe(r.p.pid);
    expect(w.pid).not.toBe(r.p.pid);
    expect(await info(4791)).toMatchObject({ root: project, supervised: true });

    const found = bin(['--find', project]);
    expect(found.status).toBe(0);
    expect(found.stdout.trim()).toBe('4791');
    expect(bin(['--find', tmp]).status).toBe(1);
  }, 15000);

  it('POST /restart-server brings the server back on the same port with --continue (and without --new)', async () => {
    launch(['--port', '4792', '--new']);
    const first = await waitFor(() => windows()['4792']);
    expect(argsOf(first.pid)).toContain('--new');
    const res = await fetch('http://127.0.0.1:4792/restart-server', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4792' },
    });
    expect(res.status).toBe(200);
    const next = await waitFor(() => {
      const w = windows()['4792'];
      return w && w.pid !== first.pid ? w : null;
    });
    expect(await info(4792)).toMatchObject({ root: project });
    const a = argsOf(next.pid);
    expect(a).toContain('--continue');
    expect(a).not.toContain('--new');
    expect(next.launcherPid).toBe(first.launcherPid);
  }, 15000);

  it('a child killed by a signal counts as a crash and is relaunched with --continue', async () => {
    const r = launch(['--port', '4793', '--resume', 'abc-1', '--fork']);
    const first = await waitFor(() => windows()['4793']);
    process.kill(first.pid, 'SIGKILL');
    const next = await waitFor(() => {
      const w = windows()['4793'];
      return w && w.pid !== first.pid ? w : null;
    });
    const a = argsOf(next.pid);
    expect(a).toContain('--continue');
    expect(a).not.toContain('--resume');
    expect(a).not.toContain('--fork');
    expect(r.err()).toMatch(/relaunching \(1 crash/);
    expect(alive(r.p.pid!)).toBe(true);
  }, 15000);

  it('5 fast crashes give up with the crash code', async () => {
    const t0 = Date.now();
    const r = launch(['--port', '4794'], { NOTA_BENE_TEST_CRASH: '1' });
    expect(await r.exited).toBe(1);
    expect(r.err().match(/relaunching/g)).toHaveLength(4);
    expect(r.err()).toMatch(/giving up/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4000); // 1 s between crashes
    expect(windows()['4794']).toBeUndefined();
  }, 15000);

  it('SIGTERM stops the child, removes the entry and exits 0 without a relaunch', async () => {
    const r = launch(['--port', '4795']);
    const w = await waitFor(() => windows()['4795']);
    r.p.kill('SIGTERM');
    expect(await r.exited).toBe(0);
    expect(windows()['4795']).toBeUndefined();
    expect(alive(w.pid)).toBe(false);
    await new Promise((res) => setTimeout(res, 1500)); // no relaunch shows up
    expect(await info(4795)).toBeNull();
  }, 15000);

  it('without --port takes the first free port of the range, by a real bind test (loopback and wildcard holders)', async () => {
    await hold(4791);
    await hold(4792, '0.0.0.0');
    const expected = await firstFree(4793, 4795);
    launch([], { NOTA_BENE_PORT_RANGE: '4791-4795' });
    const w = await waitFor(() => windows()[String(expected)]);
    expect(w.root).toBe(project);
    expect(Object.keys(windows())).toEqual([String(expected)]);
  }, 15000);

  it('a first start that loses the port (server exits 98) retries once on a free port when the port was picked', async () => {
    await hold(4791); // passes no bind test, but the launcher was told the port was auto-picked (as --detach does)
    const r = launch(['--port', '4791'], { NOTA_BENE_AUTOPORT: '1', NOTA_BENE_PORT_RANGE: '4791-4795' });
    const expected = await firstFree(4792, 4795);
    const w = await waitFor(() => windows()[String(expected)]);
    expect(w.root).toBe(project);
    expect(r.err()).toMatch(new RegExp(`port 4791 was taken meanwhile, retrying on ${expected}`));
    expect(windows()['4791']).toBeUndefined();
  }, 15000);

  it('an explicit busy --port is an error (98), not a crash loop', async () => {
    await hold(4791);
    const t0 = Date.now();
    const r = launch(['--port', '4791']);
    expect(await r.exited).toBe(98);
    expect(r.err()).toMatch(/port 4791 is in use/);
    expect(r.err()).not.toMatch(/relaunching/);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);

  it('a relaunch reopens the folder the window switched to', async () => {
    const projB = path.join(tmp, 'projB');
    fs.mkdirSync(projB);
    // a session lives in projB, so the server lets a new session open there
    const fake = path.join(tmp, 'fake.json');
    fs.writeFileSync(fake, JSON.stringify({
      sessions: [{ id: '33333333-3333-4333-8333-333333333333', cwd: '../projB', lastModified: 1, fileSize: 1, history: [] }],
      turns: [{ text: 'hi' }],
    }));
    launch(['--port', '4792'], {}, fake);
    const first = await waitFor(() => windows()['4792']);
    const ws = new WebSocket('ws://127.0.0.1:4792/ws');
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    ws.send(JSON.stringify({ type: 'switch', id: null, dir: projB }));
    // the supervised server re-registers itself with the new root
    await waitFor(async () => (await info(4792))?.root === projB && windows()['4792']?.root === projB);
    ws.close();
    const res = await fetch('http://127.0.0.1:4792/restart-server', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4792' },
    });
    expect(res.status).toBe(200);
    const next = await waitFor(() => {
      const w = windows()['4792'];
      return w && w.pid !== first.pid ? w : null;
    });
    expect(await info(4792)).toMatchObject({ root: projB });
    expect(next.root).toBe(projB);
    expect(argsOf(next.pid)).toContain(projB);
  }, 15000);

  it('more than 10 restarts (75) within a minute give up', async () => {
    const r = launch(['--port', '4794'], { NOTA_BENE_TEST_CRASH: '75' });
    expect(await r.exited).toBe(75);
    expect(r.err()).toMatch(/11 restarts in the last minute — restarting in a loop, giving up/);
  }, 15000);

  it('--detach prints exactly the URL and exits 0 while the window keeps running', async () => {
    const r = spawnSync(process.execPath, [BIN, project, '--port', '4793', '--detach', '--fake', FAKE, '--no-open'], {
      env: env(),
      encoding: 'utf8',
      timeout: 25000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('http://127.0.0.1:4793\n');
    const w = windows()['4793']!; // the URL comes only after the registry has the window
    expect(w.root).toBe(project);
    expect(alive(w.launcherPid!)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'nota-bene-4793.log'))).toBe(true);
    expect(await info(4793)).toMatchObject({ root: project });
  }, 15000);

  it('refuses $HOME and / with the prototype message', () => {
    for (const dir of [tmp, '/']) {
      const r = bin([dir, '--no-open'], { HOME: tmp });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing to open the whole .* as a project — cd into a project first/);
    }
  });

  it('--last prints the saved session only while its transcript exists', () => {
    const id = '0123abcd-0000-4000-8000-000000000000';
    fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ [project]: id }));
    expect(bin(['--last', project]).status).toBe(1);
    fs.mkdirSync(path.join(tmp, 'claude/projects/x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'claude/projects/x', `${id}.jsonl`), '');
    const r = bin(['--last', project]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(id);
  });
});

describe('web/dist freshness', () => {
  const touch = (f: string, t: number) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    fs.utimesSync(f, t / 1000, t / 1000);
  };
  const repo = () => {
    const r = path.join(tmp, 'repo');
    const now = Date.now();
    touch(path.join(r, 'web/src/deep/a.tsx'), now - 60_000);
    touch(path.join(r, 'web/index.html'), now - 60_000);
    touch(path.join(r, 'shared/src/x.ts'), now - 60_000);
    return r;
  };

  const built = (r: string, t: number) => {
    touch(path.join(r, 'web/dist/index.html'), t);
    touch(path.join(r, 'web/dist/.nb-built'), t);
  };

  it('needs a build when dist or its stamp is missing, or a source is newer than the stamp', () => {
    const r = repo();
    expect(needsBuild(r)).toBe(true);
    touch(path.join(r, 'web/dist/index.html'), Date.now() - 30_000);
    expect(needsBuild(r)).toBe(true); // no stamp: not built by us, or the build did not finish
    built(r, Date.now() - 30_000);
    expect(needsBuild(r)).toBe(false);
    for (const f of ['shared/src/new.ts', 'web/vite.config.ts', 'web/package.json', 'package-lock.json']) {
      built(r, Date.now() - 30_000);
      touch(path.join(r, f), Date.now());
      expect(needsBuild(r), f).toBe(true);
    }
  });

  it('runs the build command only when stale, and stamps only a build that wrote dist (NOTA_BENE_BUILD_CMD stub)', () => {
    const r = repo();
    built(r, Date.now() - 30_000);
    const marker = path.join(tmp, 'built');
    const stub = { ...process.env, NOTA_BENE_BUILD_CMD: `touch '${marker}'` };
    ensureBuild(r, stub, 'ignore');
    expect(fs.existsSync(marker)).toBe(false);
    touch(path.join(r, 'web/src/deep/a.tsx'), Date.now());
    ensureBuild(r, stub, 'ignore');
    expect(fs.existsSync(marker)).toBe(true);
    expect(needsBuild(r)).toBe(true); // the stub wrote no dist/index.html: no stamp
    ensureBuild(r, { ...process.env, NOTA_BENE_BUILD_CMD: 'touch web/dist/index.html' }, 'ignore');
    expect(needsBuild(r)).toBe(false);
  });

  it('a held build lock is waited for, then taken as stale: it builds anyway and leaves no lock', () => {
    const r = repo();
    const lock = buildLock(r);
    fs.mkdirSync(lock, { recursive: true });
    try {
      const marker = path.join(tmp, 'built');
      const t0 = Date.now();
      ensureBuild(r, { ...process.env, NOTA_BENE_BUILD_CMD: `touch '${marker}'` }, 'ignore', 300);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
      expect(fs.existsSync(marker)).toBe(true);
      // a lock we did not take is not ours to remove
      expect(fs.existsSync(lock)).toBe(true);
      fs.rmSync(lock, { recursive: true });
      ensureBuild(r, { ...process.env, NOTA_BENE_BUILD_CMD: 'true' }, 'ignore', 300);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });
});
