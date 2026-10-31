// Spawns the real launcher (bin/nota-bene.mjs) with the fake agent, a temp NOTA_BENE_HOME and ports 4791-4795.
// Every launcher runs in its own process group; afterEach SIGKILLs the groups, so no server outlives a test.
import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WS from 'ws';
import { shellEnv } from '../server/src/session/shellText.ts';
// @ts-expect-error plain ESM, no types
import { acquireLaunchLock, buildLock, candidatePorts, ensureBuild, needsBuild, portFree, serverEnv } from './nota-bene.mjs';

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
  NOTA_BENE_PORT_RANGE: '4791-4795', // a picked port never lands on a live window's or the dev server's
  TMPDIR: tmp, // the --detach log and the build lock stay out of the real TMPDIR
  ...extra,
});

type Run = { p: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null> };
function launch(args: string[], extra: Record<string, string> = {}, fake = FAKE, dir = project): Run {
  const p = spawn(process.execPath, [BIN, dir, ...args, '--fake', fake, '--no-open'], {
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

const FAKE_NONCE = 'f0'.repeat(16);
/** A request handler for a fake window: proves itself on /hello as a window of this state dir would, then answers /info with `root`. */
async function fakeWindowHandler(root: string, seen: string[] = []) {
  const { proofFor } = await import('../server/src/auth.ts');
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    seen.push(`${req.url} ${req.headers.authorization}`);
    const m = /^\/hello\?c=([0-9a-f]+)$/.exec(req.url ?? '');
    const port = (req.socket.address() as net.AddressInfo | null)?.port ?? req.socket.localPort!;
    if (m) return void res.setHeader('content-type', 'application/json').end(JSON.stringify({ proof: proofFor(tokenOf(), port, FAKE_NONCE, m[1]!), n: FAKE_NONCE }));
    res.setHeader('content-type', 'application/json').end(JSON.stringify({ root }));
  };
}

/** The access token of the test's state dir (the real server creates it at start). */
const tokenOf = () => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
const authHeaders = () => ({ authorization: `Bearer ${tokenOf()}` });
const loginRe = '#t=[0-9a-f]{64}';
/** The login value the launcher puts in a window's URL: HMAC of its port and the launch's nonce (asked of the window itself). */
async function loginOf(port: number): Promise<string> {
  const { loginCredential } = await import('../server/src/auth.ts');
  const n = ((await (await fetch(`http://127.0.0.1:${port}/hello?c=${'ab'.repeat(16)}`)).json()) as { n: string }).n;
  return loginCredential(tokenOf(), port, n);
}
const loginUrlOf = async (port: number) => `http://127.0.0.1:${port}/#t=${await loginOf(port)}`;

async function info(port: number): Promise<{ root: string; supervised: boolean } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/info`, { headers: authHeaders(), signal: AbortSignal.timeout(500) });
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
const launchLock = () => path.join(home, 'locks', createHash('sha1').update(project).digest('hex').slice(0, 16));
const deadPid = () => Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }));
const bin = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { env: env(extra), encoding: 'utf8', timeout: 10000 });

describe('nota-bene launcher', () => {
  it('keeps Claude and Codex windows separate in the same project', async () => {
    const claude = launch(['--port', '4791']);
    await waitFor(() => windows()['4791']);
    const codex = launch(['--port', '4792', '--agent', 'codex']);
    await waitFor(() => fs.existsSync(path.join(home, 'providers', 'codex', 'windows', '4792.json')));
    expect(codex.out()).not.toContain('already open');
    expect(bin(['--find', project]).stdout.trim()).toBe('4791');
    const foundCodex = bin(['--find', project, '--agent', 'codex']);
    expect({ code: foundCodex.status, error: foundCodex.stderr }).toEqual({ code: 0, error: '' });
    expect(foundCodex.stdout.trim()).toBe('4792');
    expect(fs.existsSync(path.join(home, 'providers', 'codex', 'token'))).toBe(true);
    expect(fs.readFileSync(path.join(home, 'providers', 'codex', 'token'), 'utf8')).not.toBe(tokenOf());
  }, 15000);

  it('starts, /info answers supervised, the registry has the entry with both pids; --find reports it', async () => {
    const r = launch(['--port', '4791']);
    const w = await waitFor(() => windows()['4791']);
    expect(w.root).toBe(project);
    expect(w.launcherPid).toBe(r.p.pid);
    expect(w.pid).not.toBe(r.p.pid);
    expect(await info(4791)).toMatchObject({ root: project, supervised: true });
    // in the foreground (the /nb background task) the server's URL line reaches the launcher's stdout: the task output
    expect(r.out().split('\n')[0]).toBe(`Nota Bene: http://127.0.0.1:4791  project: ${project}`);

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
      headers: { origin: 'http://127.0.0.1:4792', ...authHeaders() },
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

  it('an install with no agent binary stops at once, with no relaunch', async () => {
    const r = launch(['--port', '4794'], { NOTA_BENE_TEST_CRASH: '76' });
    expect(await r.exited).toBe(76);
    expect(r.err()).not.toMatch(/relaunching/);
    expect(windows()['4794']).toBeUndefined();
  }, 15000);

  // what Claude Code sends when the /nb background task is stopped
  // SIGTERM takes the same handler (the parent-shell test below goes through it)
  it('SIGINT stops the child, removes the entry and exits 0 without a relaunch', async () => {
    const r = launch(['--port', '4795']);
    const w = await waitFor(() => windows()['4795']);
    r.p.kill('SIGINT');
    expect(await r.exited).toBe(0);
    expect(windows()['4795']).toBeUndefined();
    expect(alive(w.pid)).toBe(false);
    await new Promise((res) => setTimeout(res, 1500)); // no relaunch shows up
    expect(await info(4795)).toBeNull();
  }, 15000);

  it('a SIGKILLed launcher takes its server with it: gone within 5 s, port free (the server watches its ppid)', async () => {
    const r = launch(['--port', '4794']);
    const w = await waitFor(() => windows()['4794']);
    await waitFor(() => info(4794));
    r.p.kill('SIGKILL');
    expect(await r.exited).toBeNull();
    const t0 = Date.now();
    await waitFor(() => !alive(w.pid), 5000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await portFree(4794)).toBe(true);
    // the stale entry (launcher and server dead) is pruned by the next --find
    expect(bin(['--find', project]).status).toBe(1);
    expect(windows()['4794']).toBeUndefined();
  }, 15000);

  it('a launcher whose parent shell is SIGKILLed stops with its server: gone within 6 s, port free', async () => {
    // `; true`: the shell stays the launcher's parent instead of exec-ing it
    const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const cmd = [process.execPath, BIN, project, '--port', '4793', '--fake', FAKE, '--no-open'].map(q).join(' ');
    const wrapper = spawn('/bin/sh', ['-c', `${cmd}; true`], { env: env(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    groups.add(wrapper.pid!);
    let err = '';
    wrapper.stderr!.on('data', (d) => (err += d));
    const w = await waitFor(() => windows()['4793']);
    await waitFor(() => info(4793));
    expect(w.launcherPid).not.toBe(wrapper.pid);
    process.kill(wrapper.pid!, 'SIGKILL'); // the shell only, not its group
    const t0 = Date.now();
    await waitFor(() => !alive(w.launcherPid!) && !alive(w.pid), 6000);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(await portFree(4793)).toBe(true);
    expect(windows()['4793']).toBeUndefined(); // stopped as on SIGTERM: unregistered
    expect(err).toMatch(/the parent process \(pid \d+\) is gone — stopping/);
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
    const ws = new WebSocket('ws://127.0.0.1:4792/ws', { headers: authHeaders() });
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
      headers: { origin: 'http://127.0.0.1:4792', ...authHeaders() },
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

  it('a restarting window keeps its port: a launch of another folder in the gap takes a different one', async () => {
    const a = launch(['--port', '4791']);
    const first = await waitFor(() => windows()['4791']);
    const projB = path.join(tmp, 'projB');
    fs.mkdirSync(projB);
    process.kill(first.pid, 'SIGKILL');
    const b = launch([], {}, FAKE, projB); // picks a port while A's server is down
    const bPort = await waitFor(() => Object.entries(windows()).find(([, w]) => w.root === projB)?.[0]);
    expect(bPort).not.toBe('4791');
    const back = await waitFor(() => {
      const w = windows()['4791'];
      return w && w.pid !== first.pid && w.root === project ? w : null;
    });
    expect(back.launcherPid).toBe(a.p.pid);
    expect(await info(4791)).toMatchObject({ root: project });
    expect(await info(Number(bPort))).toMatchObject({ root: projB });
    expect(alive(b.p.pid!)).toBe(true);
  }, 20000);

  it('a launch of the same folder during the restart gap waits for the window instead of opening a second one', async () => {
    launch(['--port', '4792']);
    const first = await waitFor(() => windows()['4792']);
    process.kill(first.pid, 'SIGKILL');
    await waitFor(() => !alive(first.pid));
    const r = launch([]);
    expect(await r.exited, r.err()).toBe(0);
    expect(r.out()).toBe('nota-bene: already open at http://127.0.0.1:4792\n');
    expect(Object.keys(windows())).toEqual(['4792']);
  }, 20000);

  it('a relaunch that finds its port taken gives up at once, not after 5 crashes', async () => {
    const r = launch(['--port', '4793']);
    const first = await waitFor(() => windows()['4793']);
    process.kill(first.pid, 'SIGKILL');
    // take the port inside the 1 s crash pause (retry while the dead server's socket is being released)
    await waitFor(() => new Promise<boolean>((res) => {
      const s = net.createServer((sock) => {
        sock.on('error', () => {});
        sockets.add(sock);
      });
      s.once('error', () => res(false));
      s.listen(4793, '127.0.0.1', () => {
        servers.push(s);
        res(true);
      });
    }), 900);
    expect(await r.exited).toBe(98);
    expect(r.err()).toMatch(/port 4793 was taken during the restart/);
    expect(r.err().match(/relaunching/g)).toHaveLength(1); // the SIGKILL crash only
    expect(windows()['4793']).toBeUndefined();
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
    expect(r.stdout).toBe(`opened ${await loginUrlOf(4793)}\n`);
    const w = windows()['4793']!; // the URL comes only after the registry has the window
    expect(w.root).toBe(project);
    expect(alive(w.launcherPid!)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'nota-bene-4793.log'))).toBe(true);
    expect(await info(4793)).toMatchObject({ root: project });
    // a second launch on the same folder, plain and --detach, gives way to the window
    const r2 = launch([]);
    expect(await r2.exited, r2.err()).toBe(0);
    expect(r2.out()).toBe('nota-bene: already open at http://127.0.0.1:4793\n');
    const d2 = launch(['--detach']);
    expect(await d2.exited, d2.err()).toBe(0);
    expect(d2.out()).toBe(`already-open ${await loginUrlOf(4793)}\n`);
    expect(Object.keys(windows())).toEqual(['4793']);
    // a window missing from the registry (a failed registry write) is found by /info
    const other = path.join(tmp, 'project-b');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(home, 'token'), 'e'.repeat(64), { mode: 0o600 }); // the fake window needs a token to prove with
    const s2 = http.createServer(await fakeWindowHandler(other));
    await new Promise<void>((r) => s2.listen(4792, '127.0.0.1', () => r()));
    try {
      const d3 = launch(['--detach'], {}, FAKE, other);
      expect(await d3.exited, d3.err()).toBe(0);
      expect(d3.out()).toBe(`already-open http://127.0.0.1:4792/#t=${(await import('../server/src/auth.ts')).loginCredential(tokenOf(), 4792, FAKE_NONCE)}\n`);
      expect(Object.keys(windows())).toEqual(['4793']);
    } finally {
      s2.closeAllConnections();
      await new Promise((r) => s2.close(r));
    }
  }, 40000);

  it('two parallel --detach launches on one folder end with ONE window: one says opened, the other already-open', async () => {
    const [a, b] = [launch(['--detach']), launch(['--detach'])];
    expect(await a.exited, a.err()).toBe(0);
    expect(await b.exited, b.err()).toBe(0);
    const [verbA, urlA] = a.out().trim().split(' ');
    const [verbB, urlB] = b.out().trim().split(' ');
    expect([verbA, verbB].sort()).toEqual(['already-open', 'opened']);
    expect(urlB).toBe(urlA);
    const entries = Object.entries(windows()).filter(([, w]) => w.root === project);
    expect(entries).toHaveLength(1);
    expect(urlA).toBe(await loginUrlOf(Number(entries[0]![0])));
    const roots = [];
    for (let p = 4791; p <= 4795; p++) roots.push((await info(p))?.root);
    expect(roots.filter((r) => r === project)).toHaveLength(1);
    expect(fs.existsSync(launchLock())).toBe(false); // released once the window was registered
  }, 30000);

  it.each([
    ['its owner is dead', (lock: string) => fs.writeFileSync(path.join(lock, 'pid'), String(deadPid()))],
    ['it is older than 60 s', (lock: string) => {
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); // alive, but stuck
      const old = (Date.now() - 61_000) / 1000;
      fs.utimesSync(path.join(lock, 'pid'), old, old);
      fs.utimesSync(lock, old, old);
    }],
  ])('a stale launch lock (%s) is broken', async (_, make) => {
    fs.mkdirSync(launchLock(), { recursive: true });
    make(launchLock());
    const t0 = Date.now();
    const r = launch(['--detach']);
    expect(await r.exited, r.err()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000); // not the 30 s wait-then-go-unguarded
    expect(r.out()).toMatch(new RegExp(`^opened http://127\\.0\\.0\\.1:\\d+/${loginRe}\\n$`));
    expect(fs.existsSync(launchLock())).toBe(false);
  }, 20000);

  it.each(['', 'garbage'])('a fresh lock with a pid file of %j is held, not taken for dead', async (content) => {
    fs.mkdirSync(launchLock(), { recursive: true });
    fs.writeFileSync(path.join(launchLock(), 'pid'), content);
    const saved = process.env.NOTA_BENE_HOME;
    process.env.NOTA_BENE_HOME = home;
    try {
      const t0 = Date.now();
      const release = await acquireLaunchLock(project, 300);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300); // waited, then went on unguarded
      release();
      expect(fs.readFileSync(path.join(launchLock(), 'pid'), 'utf8')).toBe(content); // not ours: untouched
    } finally {
      if (saved === undefined) delete process.env.NOTA_BENE_HOME;
      else process.env.NOTA_BENE_HOME = saved;
    }
  });

  it('a --detach timeout kills the detached launcher and its server, then releases the lock', async () => {
    const r = launch(['--detach'], { NOTA_BENE_DETACH_WAIT_MS: '1' });
    expect(await r.exited).toBe(1);
    expect(r.err()).toMatch(/the server did not come up in 0\.001s/);
    expect(fs.existsSync(launchLock())).toBe(false);
    await new Promise((res) => setTimeout(res, 500));
    const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    expect(ps.split('\n').filter((l) => l.includes(project))).toEqual([]);
    for (let p = 4791; p <= 4795; p++) expect((await info(p))?.root).not.toBe(project);
  }, 15000);

  it('a picked port avoids the dev port 4780 and the smoke/test ports 4790-4795, unless the range is set', () => {
    const ports: number[] = candidatePorts({});
    expect(ports[0]).toBe(4777);
    expect(ports.at(-1)).toBe(4799);
    for (const p of [4780, 4790, 4791, 4792, 4793, 4794, 4795]) expect(ports).not.toContain(p);
    expect(ports).toContain(4781);
    expect(ports).toContain(4796);
    expect(candidatePorts({ NOTA_BENE_PORT_RANGE: '4791-4795' })).toEqual([4791, 4792, 4793, 4794, 4795]);
  });

  it('refuses $HOME and /', () => {
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

describe('serverEnv', () => {
  it('strips from the server child what the `! cmd` environment strips (server/src/session/shellText.ts shellEnv)', () => {
    for (const base of [
      { npm_execpath: '/x/npm', npm_lifecycle_event: 'start', npm_config_registry: 'r', INIT_CWD: '/w', PATH: '/p/node_modules/.bin:/q/node-gyp-bin:/usr/bin:/bin', HOME: '/h' },
      { NPM_TOKEN: 't', npm_config_registry: 'r', INIT_CWD: '/w', PATH: '/p/node_modules/.bin:/usr/bin' },
    ]) {
      const theirs = serverEnv(base, 1);
      delete theirs.NOTA_BENE_SUPERVISED;
      delete theirs.NOTA_BENE_LAUNCHER_PID;
      expect(shellEnv(base)).toEqual(theirs);
    }
  });
  it('drops npm_* and INIT_CWD and the node_modules/.bin PATH prefix npm adds, keeps the rest of PATH', () => {
    const e = serverEnv({
      npm_execpath: '/x/npx-cli.js', npm_config_cache: 'x', npm_lifecycle_event: 'npx', NPM_CONFIG_X: 'y', INIT_CWD: '/z', KEEP: '1', NOTA_BENE_AUTOPORT: undefined,
      PATH: ['/a/b/node_modules/.bin', '/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin', '/usr/bin', '/proj/node_modules/.bin', '/bin'].join(path.delimiter),
    }, 42);
    expect(Object.keys(e).filter((k) => /^npm_/.test(k) || k === 'INIT_CWD')).toEqual([]);
    expect(e.NPM_CONFIG_X).toBe('y'); // upper-case ones are the user's own (NPM_TOKEN ...)
    expect(e.KEEP).toBe('1');
    expect(e.PATH).toBe(['/usr/bin', '/proj/node_modules/.bin', '/bin'].join(path.delimiter)); // only the leading npm prefix goes
    expect(e.NOTA_BENE_SUPERVISED).toBe('1');
    expect(e.NOTA_BENE_LAUNCHER_PID).toBe('42');
  });
  it('a plain shell launch (no npm_execpath / npm_lifecycle_event) keeps NPM_TOKEN, npm_config_* and the whole PATH', () => {
    const base = { NPM_TOKEN: 't', npm_config_registry: 'https://r.example/', INIT_CWD: '/z', PATH: ['/a/node_modules/.bin', '/usr/bin'].join(path.delimiter) };
    const e = serverEnv(base, 7);
    expect(e).toMatchObject({ NPM_TOKEN: 't', npm_config_registry: 'https://r.example/', INIT_CWD: '/z', PATH: base.PATH, NOTA_BENE_LAUNCHER_PID: '7' });
  });
  it('leaves a PATH without the prefix alone and copes with none', () => {
    expect(serverEnv({ npm_execpath: 'x', PATH: '/usr/bin:/bin' }, 1).PATH).toBe('/usr/bin:/bin');
    expect('PATH' in serverEnv({ npm_execpath: 'x' }, 1)).toBe(false);
  });
});

describe('--help, --version and a stray dash', () => {
  it('--help / -h print the usage and exit 0; --version / -v print the package version and exit 0', () => {
    const version = (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
    for (const a of ['--help', '-h']) {
      const r = bin([a]);
      expect([a, r.status]).toEqual([a, 0]);
      expect(r.stdout).toContain('Usage: nota-bene');
    }
    for (const a of ['--version', '-v']) {
      const r = bin([a]);
      expect([a, r.status, r.stdout.trim()]).toEqual([a, 0, version]);
    }
  });
  it('an unknown leading-dash argument is a usage error (exit 2), not an ENOENT on a folder of that name', () => {
    for (const a of ['-x', '-p']) {
      const r = bin([a]);
      expect([a, r.status]).toEqual([a, 2]);
      expect(r.stderr).toContain(`Unknown option: ${a}`);
      expect(r.stderr).toContain('Usage: nota-bene');
    }
  });
});

describe('the access token', () => {
  /** a PATH dir whose `open` / `xdg-open` record their argument instead of starting a browser */
  function stubOpener(): { path: string; log: string } {
    const d = path.join(tmp, 'opener');
    fs.mkdirSync(d);
    const log = path.join(tmp, 'opened.log');
    for (const n of ['open', 'xdg-open']) {
      fs.writeFileSync(path.join(d, n), `#!/bin/sh\necho "$1" >> "${log}"\n`);
      fs.chmodSync(path.join(d, n), 0o755);
    }
    return { path: `${d}:${process.env.PATH}`, log };
  }
  const logLines = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

  it('two first launches at once (two folders, a fresh state dir) agree on one token', async () => {
    const other = path.join(tmp, 'project-b');
    fs.mkdirSync(other);
    launch(['--port', '4791']);
    launch(['--port', '4792'], {}, FAKE, other);
    await waitFor(() => windows()['4791'] && windows()['4792']);
    expect(await info(4791)).toMatchObject({ root: project });
    expect(await info(4792)).toMatchObject({ root: other });
    expect(fs.statSync(path.join(home, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  }, 20000);

  it('the foreground output, the log, and every process\'s argv are free of the token, the login value and the credentials', async () => {
    const r = launch(['--port', '4791']);
    const w = await waitFor(() => windows()['4791']);
    const token = tokenOf();
    const { helperCredential } = await import('../server/src/auth.ts');
    const n = ((await (await fetch(`http://127.0.0.1:4791/hello?c=${'ab'.repeat(16)}`)).json()) as { n: string }).n;
    const secrets = [token, helperCredential(token, 4791, n), await loginOf(4791)];
    const other = path.join(tmp, 'project-b');
    fs.mkdirSync(other);
    const d = spawnSync(process.execPath, [BIN, other, '--port', '4793', '--detach', '--fake', FAKE, '--no-open'], { env: env(), encoding: 'utf8', timeout: 25000 });
    expect(d.status).toBe(0);
    expect(d.stdout).toBe(`opened ${await loginUrlOf(4793)}\n`); // the one place the URL carries the login value (never the token)
    expect(d.stdout).not.toContain(token);
    const log = fs.readFileSync(path.join(tmp, 'nota-bene-4793.log'), 'utf8');
    expect(fs.statSync(path.join(tmp, 'nota-bene-4793.log')).mode & 0o777).toBe(0o600); // $TMPDIR may be a shared /tmp
    const ps = execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8' });
    for (const secret of secrets) {
      expect(r.out()).not.toContain(secret);
      expect(r.err()).not.toContain(secret);
      expect(log).not.toContain(secret);
      expect(ps).not.toContain(secret);
    }
    expect(argsOf(w.pid)).not.toContain(token);
  }, 40000);

  describe('the detach log', () => {
    const logPath = () => path.join(tmp, 'nota-bene-4793.log');
    const detachOther = () => {
      const other = path.join(tmp, 'project-b');
      fs.mkdirSync(other, { recursive: true });
      return spawnSync(process.execPath, [BIN, other, '--port', '4793', '--detach', '--fake', FAKE, '--no-open'], { env: env(), encoding: 'utf8', timeout: 25000 });
    };

    it('an old 644 log becomes 600 and is emptied', async () => {
      fs.writeFileSync(logPath(), 'STALE-LOG-LINE\n', { mode: 0o644 });
      fs.chmodSync(logPath(), 0o644);
      const d = detachOther();
      expect(d.status, d.stderr).toBe(0);
      expect(fs.statSync(logPath()).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(logPath(), 'utf8')).not.toContain('STALE-LOG-LINE');
    }, 40000);

    it('a symlink is not followed: the window still starts, there is no log, one line says so', async () => {
      const victim = path.join(tmp, 'victim');
      fs.writeFileSync(victim, 'keep');
      fs.symlinkSync(victim, logPath());
      const d = detachOther();
      expect(d.status, d.stderr).toBe(0);
      expect(d.stdout).toMatch(/^opened http:\/\/127\.0\.0\.1:4793\/#t=[0-9a-f]{64}\n$/);
      expect(d.stderr).toMatch(/no log: cannot open .*nota-bene-4793\.log/);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
    }, 40000);

    it('a FIFO does not hang --detach', async () => {
      execFileSync('mkfifo', [logPath()]);
      const t0 = Date.now();
      const d = detachOther();
      expect(Date.now() - t0).toBeLessThan(20000);
      expect(d.status, d.stderr).toBe(0);
      expect(d.stderr).toMatch(/no log:/);
    }, 40000);
  });

  it('--url prints the login URL (the launch\'s login value, never the token); --front opens a page in the state dir (mode 600), never the URL in argv', async () => {
    launch(['--port', '4791']);
    await waitFor(() => windows()['4791']);
    const token = tokenOf();
    const login = await loginOf(4791);
    const u = bin(['--url', '4791']);
    expect([u.status, u.stdout]).toEqual([0, `http://127.0.0.1:4791/#t=${login}\n`]);
    expect(u.stdout).not.toContain(token);
    expect(bin(['--url', 'http://localhost:5173']).status).toBe(1); // a dev page that cannot prove itself gets nothing
    for (const bad of ['http://evil.example:80', 'file:///etc/passwd', 'abc', '99999']) expect(bin(['--url', bad]).status, bad).toBe(2);

    const op = stubOpener();
    const f = bin(['--front', '4791'], { PATH: op.path });
    expect(f.status, f.stderr).toBe(0);
    await waitFor(() => logLines(op.log).length > 0);
    const [arg] = logLines(op.log);
    expect(arg).not.toContain(token);
    expect(arg).not.toContain(login);
    expect(arg).not.toMatch(/^https?:/);
    expect(path.dirname(arg!)).toBe(path.join(home, 'open'));
    expect(path.basename(arg!)).toMatch(/^open-[0-9a-f]+\.html$/);
    expect(fs.statSync(arg!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, 'open')).mode & 0o777).toBe(0o700);
    const page = fs.readFileSync(arg!, 'utf8');
    expect(page).toContain(`http://127.0.0.1:4791/#t=${login}`);
    expect(page).not.toContain(token);
  }, 20000);

  it('<state>/open: a symlinked dir is refused (nothing written through it), and only open-*.html pages are swept', async () => {
    launch(['--port', '4791']);
    await waitFor(() => windows()['4791']);
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(home, 'open'));
    const op = stubOpener();
    const f = bin(['--front', '4791'], { PATH: op.path });
    expect(f.status).toBe(0); // it still opens the window, without a login page
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(f.stderr).toMatch(/cannot write the page/);
    await waitFor(() => logLines(op.log).length > 0);
    expect(logLines(op.log)[0]).toBe('http://127.0.0.1:4791'); // plain: no login value in it
    fs.rmSync(path.join(home, 'open'));
    fs.mkdirSync(path.join(home, 'open'), { mode: 0o700 });
    const old = (Date.now() - 20 * 60_000) / 1000;
    for (const n of ['open-aaaa.html', 'keep-me.txt', 'open-bbbb.txt']) {
      fs.writeFileSync(path.join(home, 'open', n), 'x');
      fs.utimesSync(path.join(home, 'open', n), old, old);
    }
    expect(bin(['--front', '4791'], { PATH: op.path }).status).toBe(0);
    expect(fs.readdirSync(path.join(home, 'open')).filter((n) => !/^open-[0-9a-f]{12}\.html$/.test(n)).sort()).toEqual(['keep-me.txt', 'open-bbbb.txt']);
  }, 20000);

  it('the browser the launcher opens gets that page too (first start, and an already-open window)', async () => {
    const op = stubOpener();
    const run = spawn(process.execPath, [BIN, project, '--port', '4791', '--fake', FAKE], { env: env({ PATH: op.path }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    groups.add(run.pid!);
    await waitFor(() => windows()['4791'] && logLines(op.log).length > 0);
    const second = spawnSync(process.execPath, [BIN, project, '--fake', FAKE], { env: env({ PATH: op.path }), encoding: 'utf8', timeout: 15000 });
    expect([second.stdout, second.stderr]).toEqual(['nota-bene: already open at http://127.0.0.1:4791\n', '']); // the foreground line has no token
    await waitFor(() => logLines(op.log).length === 2);
    for (const arg of logLines(op.log)) {
      expect(arg).not.toMatch(/^https?:/);
      expect(fs.statSync(arg).mode & 0o777).toBe(0o600);
    }
  }, 30000);

  it('--find --scan also finds a window the registry does not know; the credential goes only after the proof', async () => {
    fs.writeFileSync(path.join(home, 'token'), 'd'.repeat(64), { mode: 0o600 });
    const seen: string[] = [];
    const s = http.createServer(await fakeWindowHandler(project, seen));
    await new Promise<void>((r) => s.listen(4794, '127.0.0.1', () => r()));
    try {
      expect(bin(['--find', project]).status).toBe(1); // the registry alone does not
      // async: the fake window lives in this process and must be able to answer while the launcher asks
      const f = await new Promise<{ code: number; out: string }>((resolve) => {
        execFile(process.execPath, [BIN, '--find', project, '--scan'], { env: env() }, (e, out) => resolve({ code: e ? ((e as { code?: number }).code ?? -1) : 0, out }));
      });
      expect([f.code, f.out.trim()]).toEqual([0, '4794']);
      const { helperCredential } = await import('../server/src/auth.ts');
      expect(seen[0]).toMatch(/^\/hello\?c=[0-9a-f]{32} undefined$/); // the challenge first, with no Authorization
      expect(seen.at(-1)).toBe(`/info Bearer ${helperCredential(tokenOf(), 4794, FAKE_NONCE)}`);
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }, 20000);

  it('an impostor on a range port sees no Authorization header from --find --scan, --url or --front', async () => {
    fs.writeFileSync(path.join(home, 'token'), 'd'.repeat(64), { mode: 0o600 });
    const seen: string[] = [];
    const s = http.createServer((req, res) => { seen.push(`${req.url} ${req.headers.authorization} ${req.headers.cookie}`); res.setHeader('content-type', 'application/json').end(JSON.stringify({ root: project, proof: 'ab'.repeat(32) })); });
    await new Promise<void>((r) => s.listen(4794, '127.0.0.1', () => r()));
    const op = stubOpener();
    try {
      const run = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
        execFile(process.execPath, [BIN, ...args], { env: env({ PATH: op.path }) }, (e, out) => resolve({ code: e ? ((e as { code?: number }).code ?? -1) : 0, out }));
      });
      expect((await run(['--find', project, '--scan'])).code).toBe(1);
      const u = await run(['--url', '4794']);
      expect([u.code, u.out]).toEqual([1, '']); // the token is not printed for a port that did not prove itself
      expect((await run(['--front', '4794'])).code).toBe(1);
      expect(logLines(op.log)).toEqual([]); // no page was opened for it
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((x) => x.startsWith('/hello?c=') && x.endsWith(' undefined undefined'))).toBe(true);
    } finally {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }, 20000);
});

describe('the launch nonce and the two tiers, through the real launcher', () => {
  const helloN = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/hello?c=${'ab'.repeat(16)}`)).json()) as { n: string }).n;
  const loginAt = async (port: number) => {
    const origin = `http://127.0.0.1:${port}`;
    const r = await fetch(`${origin}/auth`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ login: await loginOf(port) }) });
    return { cookie: r.headers.get('set-cookie')!.split(';')[0]!, key: ((await r.json()) as { key: string }).key, origin };
  };
  const socket = (port: number, headers: Record<string, string>, protocols: string[] = []) => new Promise<{ ok: boolean; env?: string }>((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${port}/ws`, protocols, { headers });
    ws.on('message', () => resolve({ ok: true }));
    ws.on('unexpected-response', () => resolve({ ok: false }));
    ws.on('error', () => resolve({ ok: false }));
    setTimeout(() => { ws.terminate(); resolve({ ok: false }); }, 3000).unref();
    ws.on('open', () => setTimeout(() => ws.close(), 200));
  });

  it('exit 75 relaunches with the same nonce: the same cookie and key still work; a new launch has another nonce and kills the old ones', async () => {
    launch(['--port', '4791']);
    const first = await waitFor(() => windows()['4791']);
    const n1 = await helloN(4791);
    const login = await loginAt(4791);
    expect((await socket(4791, { cookie: login.cookie, origin: login.origin }, [`nb.${login.key}`])).ok).toBe(true);
    expect((await socket(4791, { cookie: login.cookie, origin: login.origin })).ok).toBe(false); // the cookie alone: no socket
    const res = await fetch('http://127.0.0.1:4791/restart-server', { method: 'POST', headers: { origin: login.origin, ...authHeaders() } });
    expect(res.status).toBe(200);
    await waitFor(() => { const w = windows()['4791']; return w && w.pid !== first.pid ? w : null; });
    await waitFor(async () => (await info(4791)) !== null);
    expect(await helloN(4791)).toBe(n1);
    expect((await socket(4791, { cookie: login.cookie, origin: login.origin }, [`nb.${login.key}`])).ok).toBe(true); // an open tab keeps working
    const withCookie = await fetch('http://127.0.0.1:4791/info', { headers: { cookie: login.cookie, 'x-nota-bene-key': login.key } });
    expect(withCookie.status).toBe(200);
    expect((await fetch('http://127.0.0.1:4791/info', { headers: { cookie: login.cookie } })).status).toBe(401); // the cookie alone opens only /file
    // a second launcher on another port has its own launch
    launch(['--port', '4792'], {}, FAKE, (() => { const d = path.join(tmp, 'project-b'); fs.mkdirSync(d); return d; })());
    await waitFor(() => windows()['4792']);
    expect(await helloN(4792)).not.toBe(n1);
    expect((await fetch('http://127.0.0.1:4792/info', { headers: { cookie: login.cookie.replace('4791', '4792'), 'x-nota-bene-key': login.key } })).status).toBe(401);
  }, 40000);

  it('after a CRASH relaunch the nonce is new and the browser is opened on a fresh login: the old cookie, key and login value are dead', async () => {
    const op = (() => {
      const d = path.join(tmp, 'opener');
      fs.mkdirSync(d);
      const log = path.join(tmp, 'opened.log');
      for (const n of ['open', 'xdg-open']) { fs.writeFileSync(path.join(d, n), `#!/bin/sh\necho "$1" >> "${log}"\n`); fs.chmodSync(path.join(d, n), 0o755); }
      return { path: `${d}:${process.env.PATH}`, log };
    })();
    const run = spawn(process.execPath, [BIN, project, '--port', '4791', '--fake', FAKE], { env: env({ PATH: op.path }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    groups.add(run.pid!);
    const first = await waitFor(() => windows()['4791']);
    const pages = () => (fs.existsSync(op.log) ? fs.readFileSync(op.log, 'utf8').trim().split('\n').filter(Boolean) : []);
    await waitFor(() => pages().length === 1);
    const n1 = await helloN(4791);
    const old = await loginAt(4791);
    const oldLogin = await loginOf(4791);
    process.kill(first.pid, 'SIGKILL'); // a crash, not the user's restart
    const next = await waitFor(() => { const w = windows()['4791']; return w && w.pid !== first.pid ? w : null; }, 15000);
    expect(next.pid).not.toBe(first.pid);
    await waitFor(async () => (await info(4791)) !== null, 15000);
    const n2 = await helloN(4791);
    expect(n2).not.toBe(n1);
    expect((await fetch('http://127.0.0.1:4791/info', { headers: { cookie: old.cookie, 'x-nota-bene-key': old.key } })).status).toBe(401);
    expect((await socket(4791, { cookie: old.cookie, origin: old.origin }, [`nb.${old.key}`])).ok).toBe(false);
    const stale = await fetch('http://127.0.0.1:4791/auth', { method: 'POST', headers: { origin: old.origin, 'content-type': 'application/json' }, body: JSON.stringify({ login: oldLogin }) });
    expect(stale.status).toBe(401);
    await waitFor(() => pages().length === 2); // the user is offered a fresh login
    const fresh = fs.readFileSync(pages()[1]!, 'utf8');
    expect(fresh).toContain(`http://127.0.0.1:4791/#t=${await loginOf(4791)}`);
    expect(fresh).not.toContain(oldLogin);
  }, 40000);

  it('the nonce is not in the environment a `!` command sees', async () => {
    launch(['--port', '4791']);
    await waitFor(() => windows()['4791']);
    const n = await helloN(4791);
    const out = await new Promise<string>((resolve) => {
      const ws = new WS('ws://127.0.0.1:4791/ws', { headers: authHeaders() });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'shell-run', id: 'e', cmd: 'env' })));
      ws.on('message', (d) => { const e = JSON.parse(String(d)); if (e.kind === 'shell-end') { ws.close(); resolve(String(e.output)); } });
      setTimeout(() => resolve('timeout'), 8000).unref();
    });
    expect(out).toContain('NOTA_BENE_HOME'); // the command ran
    expect(out).not.toContain(n);
    expect(out).not.toContain('NOTA_BENE_NONCE');
  }, 20000);

  it('--url and --front with a localhost URL to an impostor send nothing and open nothing', async () => {
    fs.writeFileSync(path.join(home, 'token'), 'd'.repeat(64), { mode: 0o600 });
    const seen: string[] = [];
    const mk = async (port: number) => {
      const srv = http.createServer((req, res) => { seen.push(`${port}${req.url} ${req.headers.authorization} ${req.headers.cookie}`); res.setHeader('content-type', 'application/json').end(JSON.stringify({ proof: 'ab'.repeat(32), n: 'ab'.repeat(16) })); });
      await new Promise<void>((r) => srv.listen(port, '127.0.0.1', () => r()));
      return srv;
    };
    const imps = [await mk(4793), await mk(4794)];
    const dir = path.join(tmp, 'opener');
    fs.mkdirSync(dir);
    const log = path.join(tmp, 'opened.log');
    for (const n of ['open', 'xdg-open']) { fs.writeFileSync(path.join(dir, n), `#!/bin/sh\necho "$1" >> "${log}"\n`); fs.chmodSync(path.join(dir, n), 0o755); }
    try {
      const run = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
        execFile(process.execPath, [BIN, ...args], { env: env({ PATH: `${dir}:${process.env.PATH}` }) }, (e, out) => resolve({ code: e ? ((e as { code?: number }).code ?? -1) : 0, out }));
      });
      for (const args of [['--url', 'http://localhost:4793'], ['--front', 'http://localhost:4794'], ['--url', 'http://127.0.0.1:4793'], ['--front', '4794']]) {
        const r = await run(args);
        expect([args.join(' '), r.code, r.out]).toEqual([args.join(' '), 1, '']);
      }
      expect(fs.existsSync(log)).toBe(false);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((x) => x.includes('/hello?c=') && x.endsWith(' undefined undefined'))).toBe(true);
    } finally {
      for (const s of imps) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
    }
  }, 30000);
});

describe('a refused secret is reported once, at once, and never as a crash loop', () => {
  const seedLoose = () => { fs.writeFileSync(path.join(home, 'token'), 'a'.repeat(64), { mode: 0o644 }); fs.chmodSync(path.join(home, 'token'), 0o644); };

  it('the launcher exits 1 before spawning anything, with the one message once', async () => {
    seedLoose();
    const r = launch(['--port', '4791']);
    expect(await r.exited).toBe(1);
    const err = r.err();
    expect(err).toContain(path.join(home, 'token'));
    expect(err).toMatch(/readable by other users/);
    expect(err).toMatch(/chmod 600/);
    expect(err).not.toMatch(/relaunching|crash/);
    expect(windows()).toEqual({});
    expect(err.trim().split('\n')).toHaveLength(1);
  }, 20000);

  it('control-token too', async () => {
    fs.writeFileSync(path.join(home, 'control-token'), 'junk', { mode: 0o600 });
    const r = launch(['--port', '4791']);
    expect(await r.exited).toBe(1);
    expect(r.err()).toMatch(/control-token.*does not hold a token/);
  }, 20000);

  it('--find, --find --scan, --url and --front report the secret error (exit 3), not "not found" or "not proved"', () => {
    seedLoose();
    for (const args of [['--find', project], ['--find', project, '--scan'], ['--url', '4791'], ['--front', '4791'], ['--url', 'http://localhost:5173']]) {
      const r = bin(args);
      expect([args.join(' '), r.status]).toEqual([args.join(' '), 3]);
      expect(r.stderr).toMatch(/readable by other users/);
      expect(r.stdout).toBe('');
    }
  });

  it('a refused open-source of the token never reaches a window either (probeInfo throws)', async () => {
    const { probeInfo } = await import('../server/src/windows.ts');
    seedLoose();
    const prev = process.env.NOTA_BENE_HOME;
    process.env.NOTA_BENE_HOME = home;
    try {
      await expect(probeInfo(4791)).rejects.toThrow(/readable by other users/);
    } finally {
      if (prev === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prev;
    }
  });

  it('an opener that exits non-zero makes --front fail', async () => {
    launch(['--port', '4791']);
    await waitFor(() => windows()['4791']);
    const d = path.join(tmp, 'badopener');
    fs.mkdirSync(d);
    for (const n of ['open', 'xdg-open']) { fs.writeFileSync(path.join(d, n), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(d, n), 0o755); }
    const f = bin(['--front', '4791'], { PATH: `${d}:${process.env.PATH}` });
    expect(f.status).toBe(1);
    expect(f.stderr).toMatch(/nota-bene --url 4791/);
  }, 20000);
});
