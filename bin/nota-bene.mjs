#!/usr/bin/env node
// nota-bene — open a Nota Bene window on a folder and supervise its server.
// Plain Node ESM, no dependencies; imports the server's .ts helpers directly (Node >= 23.6 strips the types). The published
// package bundles this file and the server to plain JS (scripts/build-package.mjs).
//
//   nota-bene [dir] [--port N] [--resume ID [--fork]] [--new] [--detach] [--no-open]
//   nota-bene --find DIR [--scan]   prints the port of a live window serving DIR (exit 0), or exits 1 (3: a secret file is refused,
//                          the message says which); --scan also asks the other ports of the range (a lost registry write)
//   nota-bene --last DIR   prints DIR's saved session id if its transcript still exists (exit 0), or exits 1
//   nota-bene --url PORT   prints the window's login URL (http://127.0.0.1:PORT/#t=LOGIN), for a second browser
//   nota-bene --front PORT brings the window to front in the browser, logged in
//   --detach prints exactly one line, `opened URL` or `already-open URL` (exit 0), or an error and the log tail (exit 1);
//   the URL carries the login fragment `#t=LOGIN` (this launch's login value, never the token; the foreground line and the log never do)
//
// The access token (server/src/auth.ts) is never put in argv or a URL: a browser is opened on a page in the state dir (mode 600)
// that redirects to the login URL, and the helpers send a credential derived after the listener proved it holds the token.
//
// One window per folder: a launch takes the folder's lock, then gives way to a window already serving it.
// A picked port avoids 4780 (dev) and 4790-4795 (smoke, tests) unless NOTA_BENE_PORT_RANGE is set.
//
// Server exit codes 75 relaunches at once with --continue (more than 10 within 60 s give up);
// 0, 130, 143 exit; 98 (listen failed) on the first start retries once on another port when the port was picked
// automatically; anything else (a signal too) is a crash: relaunch after 1 s, give up at 5 crashes within 60 s.
// A relaunch keeps the port, so the open tab reconnects by itself, reopens the folder the window has now (it may have
// switched), and drops --resume/--fork/--new for --continue. The registry entry stays through the restart gap (it is
// removed only when the launcher ends), so no other launch picks the port meanwhile; a 98 on a relaunch gives up.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretError, accessToken, loginCredential, newNonce, proveListener, stateSecret } from '../server/src/auth.ts';
import { transcriptExists } from '../server/src/sessions.ts';
import { lastSession, stateDir } from '../server/src/state.ts';
import { parseProvider } from '../server/src/agent/provider.ts';
import {
  liveWindows, pidAlive, probeInfo, readWindows, registerWindow, restartingWindows, unregisterWindow,
} from '../server/src/windows.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
// the source checkout runs the server's .ts directly; the published package ships it compiled (Node does not strip types
// under node_modules) at the same relative place
const MAIN = path.join(REPO, fs.existsSync(path.join(REPO, 'server/src/main.js')) ? 'server/src/main.js' : 'server/src/main.ts');
const USAGE = 'Usage: nota-bene [dir] [--agent claude|codex] [--port N] [--resume ID [--fork]] [--new] [--detach] [--no-open]\n'
  + '       nota-bene --find DIR [--scan] | --last DIR | --url PORT | --front PORT\n'
  + '       nota-bene --help | --version';
const DEV_BACKEND_PORT = 4780; // `npm run dev`'s server (scripts/dev.mjs, web/vite.config.ts)
const EXIT_SECRET = 3; // a secret file is refused (loose mode, foreign owner, ...): --find & co. say so instead of "not found"
const RESTART = 75;
const LISTEN_FAILED = 98; // server/src/main.ts LISTEN_FAILED
const NO_AGENT_BINARY = 76; // server/src/main.ts NO_AGENT_BINARY: the server said why, a relaunch cannot help
const CLEAN_EXITS = new Set([0, 130, 143]);
const MAX_CRASHES = 5;
const MAX_RESTARTS = 10;
const GUARD_WINDOW_MS = 60_000;
// test only: NOTA_BENE_DETACH_WAIT_MS shortens the wait, to reach the timeout path
const DETACH_WAIT_MS = Number(process.env.NOTA_BENE_DETACH_WAIT_MS) || 20_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const RESTART_WAIT_MS = 10_000; // how long a launch waits for a restarting window of its folder to come back

/** This package's version (the checkout's root package.json says the same). */
export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const say = (msg) => process.stderr.write(`nota-bene: ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realDir = (d) => fs.realpathSync.native(path.resolve(d));

export function parseArgs(argv) {
  const o = { dir: undefined, port: undefined, resume: undefined, fork: false, new: false, continue: false,
    detach: false, open: true, help: false, version: false, fake: undefined, allowOrigins: [], find: undefined, last: undefined,
    scan: false, url: undefined, front: undefined };
  const value = (i) => {
    if (argv[i] === undefined) throw new Error(`${USAGE}\nMissing value for ${argv[i - 1]}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = value(++i);
      if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`${USAGE}\nInvalid port: ${v}`);
      o.port = Number(v);
    } else if (a === '--agent') o.agent = parseProvider(value(++i));
    else if (a === '--resume') o.resume = value(++i);
    else if (a === '--fork') o.fork = true;
    else if (a === '--new') o.new = true;
    else if (a === '--continue') o.continue = true;
    else if (a === '--detach') o.detach = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--fake') o.fake = path.resolve(value(++i));
    else if (a === '--allow-origin') o.allowOrigins.push(value(++i));
    else if (a === '--find') o.find = value(++i);
    else if (a === '--last') o.last = value(++i);
    else if (a === '--scan') o.scan = true;
    else if (a === '--url') o.url = value(++i);
    else if (a === '--front') o.front = value(++i);
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a.startsWith('-') && a.length > 1) throw new Error(`${USAGE}\nUnknown option: ${a}`); // not a folder named like a flag
    else if (o.dir === undefined) o.dir = a;
    else throw new Error(`${USAGE}\nUnexpected argument: ${a}`);
  }
  if (o.fork && o.resume === undefined) throw new Error(`${USAGE}\n--fork needs --resume`);
  if (o.new && o.resume !== undefined) throw new Error(`${USAGE}\n--new cannot be combined with --resume`);
  return o;
}

/** The server's argv. A relaunch resumes what the window has now (--continue), never the original --resume/--fork/--new. */
export function serverArgs(o, port, relaunch) {
  const a = [o.dir, '--port', String(port)];
  if (o.agent) a.push('--agent', o.agent);
  if (relaunch) a.push('--continue');
  else {
    if (o.resume !== undefined) a.push('--resume', o.resume);
    if (o.fork) a.push('--fork');
    if (o.new) a.push('--new');
    if (o.continue) a.push('--continue');
  }
  if (o.fake) a.push('--fake', o.fake);
  for (const origin of o.allowOrigins) a.push('--allow-origin', origin);
  return a;
}

/**
 * The server child's environment. Started through npx / npm run, we inherit npm's `npm_*` variables and a PATH that npm
 * prefixed with the package's node_modules/.bin (and node-gyp-bin); the server and the agent it runs must not see either.
 */
export function serverEnv(base, launcherPid) {
  const env = { ...base, NOTA_BENE_SUPERVISED: '1', NOTA_BENE_LAUNCHER_PID: String(launcherPid) };
  // only when npm / npx started us: a plain shell launch keeps the user's own NPM_TOKEN, npm_config_registry, PATH
  if (!(base.npm_execpath || base.npm_lifecycle_event)) return env;
  for (const k of Object.keys(env)) if (/^npm_/.test(k)) delete env[k];
  delete env.INIT_CWD; // set by npm; the dir and --fake are absolute already
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (key && env[key]) {
    const parts = env[key].split(path.delimiter);
    let i = 0;
    while (i < parts.length && /(^|[\\/])(node_modules[\\/]\.bin|node-gyp-bin)$/.test(parts[i])) i++; // npm prepends them
    env[key] = parts.slice(i).join(path.delimiter);
  }
  return env;
}

// --- ports -----------------------------------------------------------------------------------------------------

/** The live window range; NOTA_BENE_PORT_RANGE="A-B" narrows it (the tests use 4791-4795). */
function portRange(env = process.env) {
  const m = /^(\d+)-(\d+)$/.exec(env.NOTA_BENE_PORT_RANGE ?? '');
  return m ? [Number(m[1]), Number(m[2])] : [4777, 4799];
}

/** Ports a window may take: the default range minus the dev server (4780) and the smoke/test ports (4790-4795). */
export function candidatePorts(env = process.env) {
  const [from, to] = portRange(env);
  const reserved = env.NOTA_BENE_PORT_RANGE ? [] : [4780, 4790, 4791, 4792, 4793, 4794, 4795];
  const out = [];
  for (let p = from; p <= to; p++) if (!reserved.includes(p)) out.push(p);
  return out;
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    // no such address on this machine (no IPv6): nobody can hold the port there
    s.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/**
 * A real bind test (not a connect probe like the prototype's nc) on 127.0.0.1, 0.0.0.0 and ::1. The loopback test
 * alone is not enough: with SO_REUSEADDR, macOS lets 127.0.0.1:P bind while another app holds the wildcard *:P.
 */
export async function portFree(port) {
  for (const host of ['127.0.0.1', '0.0.0.0', '::1']) if (!(await canBind(port, host))) return false;
  return true;
}

/** The first port that passes the bind test and is not reserved by a live launcher (a window in its restart gap). */
async function firstFreePort(skip = new Set()) {
  const reserved = new Set(skip);
  for (const [key, w] of Object.entries(readWindows())) if (w.launcherPid && pidAlive(w.launcherPid)) reserved.add(Number(key));
  for (const p of candidatePorts()) if (!reserved.has(p) && await portFree(p)) return p;
  return null;
}

// --- web/dist --------------------------------------------------------------------------------------------------

const SOURCES = ['web/src', 'web/index.html', 'web/public', 'web/vite.config.ts', 'web/package.json', 'shared/src',
  'package-lock.json'];
const STAMP = 'web/dist/.nb-built';

function newestMtime(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of fs.readdirSync(p)) if (e !== 'node_modules') max = Math.max(max, newestMtime(path.join(p, e)));
  return max;
}

/** web/dist/index.html is missing, or the stamp of the last successful build is missing or older than a source. */
export function needsBuild(repo) {
  // an installed package carries its web/dist and no sources: there is nothing to rebuild from, and nothing may be written
  if (!fs.existsSync(path.join(repo, 'web/src'))) return false;
  let built;
  try {
    fs.statSync(path.join(repo, 'web/dist/index.html'));
    built = fs.statSync(path.join(repo, STAMP)).mtimeMs;
  } catch {
    return true;
  }
  return Math.max(...SOURCES.map((p) => newestMtime(path.join(repo, p)))) > built;
}

export const buildLock = (repo) =>
  path.join(os.tmpdir(), `nota-bene-build-${createHash('sha1').update(repo).digest('hex').slice(0, 12)}.lock`);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Builds web/dist when stale: `npm run build -w web`, or NOTA_BENE_BUILD_CMD (a shell command; the tests stub it).
 * Two launchers never build at once (an mkdir lock; after lockWaitMs a lock is taken as stale and we build anyway).
 * The stamp gets the build's START time, and only if the build really wrote dist/index.html, so an edit made during
 * the build, or a stub command, still counts as stale. Returns the build output when stdio is 'pipe'.
 */
export function ensureBuild(repo, env = process.env, stdio = 'inherit', lockWaitMs = 60_000) {
  if (!needsBuild(repo)) return '';
  const lock = buildLock(repo);
  let locked = false;
  const end = Date.now() + lockWaitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      locked = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break; // cannot lock at all: build unguarded
    }
    if (Date.now() >= end) break;
    pause(250);
    if (!needsBuild(repo)) return ''; // the other launcher built it
  }
  try {
    if (!needsBuild(repo)) return '';
    const started = Date.now();
    const cmd = env.NOTA_BENE_BUILD_CMD;
    const r = cmd
      ? spawnSync(cmd, { cwd: repo, env, stdio, shell: true })
      : spawnSync('npm', ['run', 'build', '-w', 'web'], { cwd: repo, env, stdio });
    const output = stdio === 'pipe' ? `${r.stdout ?? ''}${r.stderr ?? ''}` : '';
    if (r.status !== 0) {
      throw Object.assign(new Error(`building web/dist failed (${r.error?.message ?? `exit code ${r.status}`})`), { output });
    }
    const index = path.join(repo, 'web/dist/index.html');
    if (fs.existsSync(index) && fs.statSync(index).mtimeMs >= started - 1000) {
      fs.writeFileSync(path.join(repo, STAMP), '');
      fs.utimesSync(path.join(repo, STAMP), started / 1000, started / 1000);
    }
    return output;
  } finally {
    if (locked) fs.rmSync(lock, { recursive: true, force: true });
  }
}

// --- one window per folder ------------------------------------------------------------------------------------

/**
 * The folder's launch lock: an mkdir of <stateDir>/locks/<sha1(root)[0,16]> holding a pid file. Held from before the
 * port pick until the window answers /info and is registered, so a second launch on the folder waits, then finds that
 * window instead of starting another (two launchers' bind tests can overlap, so the port alone is no arbiter).
 * A lock whose owner is dead, or older than LOCK_STALE_MS, is broken; after LOCK_WAIT_MS we go on unguarded.
 * Returns the release function (idempotent; removes the lock only while it is still ours).
 */
export async function acquireLaunchLock(root, waitMs = LOCK_WAIT_MS) {
  const lock = path.join(stateDir(), 'locks', createHash('sha1').update(root).digest('hex').slice(0, 16));
  const pidFile = path.join(lock, 'pid');
  const owner = () => {
    try {
      // empty (the holder is between its mkdir and its write) or garbage: unknown, never "dead"
      const n = Number(fs.readFileSync(pidFile, 'utf8').trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const age = () => {
    try {
      return Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      return 0;
    }
  };
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(pidFile, String(process.pid));
      let held = true;
      return () => {
        if (held && owner() === process.pid) fs.rmSync(lock, { recursive: true, force: true });
        held = false;
      };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        say(`cannot take the launch lock (${e.message}), going on without it`);
        return () => {};
      }
    }
    const pid = owner(); // undefined for a moment between the holder's mkdir and its pid write
    if ((pid !== undefined && !pidAlive(pid)) || age() > LOCK_STALE_MS) {
      // rename first: of two launchers breaking the same stale lock, only one succeeds, and neither removes a fresh one
      const gone = `${lock}.stale-${process.pid}`;
      try {
        if (owner() === pid) fs.renameSync(lock, gone);
        fs.rmSync(gone, { recursive: true, force: true });
      } catch {
        // someone else broke it first
      }
      continue;
    }
    if (Date.now() >= end) {
      say(`another launch on this folder holds the lock for over ${waitMs / 1000}s, going on without it`);
      return () => {};
    }
    await sleep(100);
  }
}

/**
 * A live window serving root (registry entries verified by /info; stale ones pruned), or undefined. A window of root
 * in its restart gap is waited for (up to waitMs), so the launch finds it instead of opening a second one.
 */
async function windowFor(root, waitMs = RESTART_WAIT_MS) {
  const end = Date.now() + waitMs;
  for (;;) {
    const hit = (await liveWindows((p) => probeInfo(p))).find((w) => w.root === root);
    if (hit) return hit;
    if (Date.now() >= end || !restartingWindows().some((w) => w.root === root)) return undefined;
    await sleep(250);
  }
}

/**
 * The launch re-check: the registry, else any port of the range whose /info serves root. The scan covers a window
 * whose registry write failed (the lock is released after /info answers either way) and prototype windows.
 */
async function servingWindow(root) {
  const hit = await windowFor(root);
  if (hit) return hit.port;
  const roots = await Promise.all(candidatePorts().map(async (p) => ((await probeInfo(p))?.root === root ? p : null)));
  return roots.find((p) => p !== null) ?? undefined;
}

// --- helpers for the /nb skill ---------------------------------------------------------------------------------

async function find(dir, scan = false) {
  accessToken(); // a refused token file is an error to report, not "no window" (nothing may be probed without it)
  const root = realDir(dir);
  const port = scan ? await servingWindow(root) : (await windowFor(root))?.port;
  if (port === undefined) return 1;
  process.stdout.write(`${port}\n`);
  return 0;
}

/** `http://127.0.0.1:PORT` for a port, or a loopback http URL as given (the dev server's); null for anything else. */
export function baseUrlOf(what) {
  if (/^\d{1,5}$/.test(what) && Number(what) > 0 && Number(what) < 65536) return `http://127.0.0.1:${Number(what)}`;
  const m = /^(http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})\/?$/.exec(what);
  return m ? m[1] : null;
}

/**
 * The URL that logs a browser in, or null when the listener did not prove itself (nothing is built for it). The fragment `#t=`
 * carries the LOGIN value of that listener's launch (HMAC of port and nonce, never the raw token): a leaked URL opens that one
 * window until its launcher exits. The fragment never reaches a server, a proxy or a log, but the page's own script reads it,
 * hence the proof first. A localhost base is the dev page (Vite proxies /hello to the backend, whose proof is bound to the
 * backend's port): the backend must prove itself directly and so must the page's port through the proxy. A program that relays
 * /hello to the real backend still passes; that is dev only, and what a proxy is.
 */
export async function loginTarget(base) {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/.exec(base);
  if (!m) return null;
  const port = Number(m[2]);
  const dev = m[1] === 'localhost';
  const bound = dev ? DEV_BACKEND_PORT : port;
  const n = await proveListener({ dial: bound, timeoutMs: 1500 });
  if (n === null) return null;
  if (dev && (await proveListener({ dial: port, bound, host: 'localhost', timeoutMs: 1500 })) === null) return null;
  return `${base}/#t=${loginCredential(accessToken(), bound, n)}`;
}

function last(dir) {
  const id = lastSession(realDir(dir));
  if (!id || (process.env.NOTA_BENE_AGENT !== 'codex' && !transcriptExists(id))) return 1;
  process.stdout.write(`${id}\n`);
  return 0;
}

// --- launch ----------------------------------------------------------------------------------------------------

function refuse(dir) {
  const home = (() => {
    try {
      return realDir(os.homedir());
    } catch {
      return os.homedir();
    }
  })();
  return dir === home || dir === '/';
}

const OPEN_PAGE_KEEP_MS = 30_000;

/**
 * The page the browser is opened on: `open URL` would put the login URL in argv, where `ps` shows it to every user. So the
 * browser gets a file in the state dir (dir 700, file 600; only this user can read it, as the token file itself) that
 * redirects to the login URL. Removed 30 s after if this process is still running; whatever is left (a launcher that exited
 * first) is swept at the next write once it is over 10 minutes old, so a page can outlive its launch by a while (same mode and
 * trust as the token file; the login value in it dies with the launch anyway). `url` is a loginTarget().
 */
export function writeOpenPage(url) {
  const dir = path.join(stateDir(), 'open');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a plain folder (a symbolic link?); delete it`);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
  try {
    fs.chmodSync(dir, 0o700); // best effort, as the state dir
  } catch { /* not ours */ }
  for (const n of fs.readdirSync(dir)) {
    if (!/^open-[0-9a-f]+\.html$/.test(n)) continue; // only our own pages
    try {
      if (Date.now() - fs.lstatSync(path.join(dir, n)).mtimeMs > 10 * 60_000) fs.rmSync(path.join(dir, n), { force: true });
    } catch {
      // gone already
    }
  }
  const file = path.join(dir, `open-${randomBytes(6).toString('hex')}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Nota Bene</title>\n<script>location.replace(${JSON.stringify(url)})</script>\n<noscript><meta http-equiv="refresh" content="0;url=${url}"></noscript>\n`, { mode: 0o600, flag: 'wx' });
  setTimeout(() => fs.rmSync(file, { force: true }), OPEN_PAGE_KEEP_MS).unref();
  return file;
}

/**
 * Opens (or brings to front) the window in the browser, logged in. `base` is `http://127.0.0.1:PORT`. A listener that cannot prove
 * itself gets the plain base (no login value in it): the page then says it is not logged in. Resolves when the opener has handed
 * the page over (bounded); callers that do not care just do not await it.
 */
async function openBrowser(base) {
  let target = base;
  try {
    const url = await loginTarget(base);
    if (url) target = writeOpenPage(url);
    else say(`nothing on ${base} proved it is this state dir's window; opening it without a login`);
  } catch (e) {
    if (e instanceof SecretError) throw e;
    say(`cannot write the page that logs the browser in (${e.message}); opening the window without it`);
  }
  const p = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore', detached: true });
  // true: the opener took it (exit 0, or it did not answer within the bound); false: it failed to start or exited non-zero
  return new Promise((resolve) => {
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
    setTimeout(() => resolve(true), 3000).unref(); // bounded; the child keeps the loop alive until it hands the page over
  });
}

const entryOf = (port) => readWindows()[String(port)];

/**
 * The detached launcher's log in $TMPDIR (a shared /tmp on Linux): opened without following a symlink and without blocking on a
 * FIFO (a FIFO would hang the open), and used only if it is a regular file of ours; then made 600 (an old 644 log becomes 600) and
 * emptied. Anything else: no log, one line saying so (stderr; stdout stays the one URL line). Returns the fd or null.
 */
export function openLog(log) {
  let fd;
  try {
    fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  } catch (e) {
    say(`no log: cannot open ${log} (${e.code ?? e.message}); the window's output is not kept`);
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (process.getuid && st.uid !== process.getuid())) {
      fs.closeSync(fd);
      say(`no log: ${log} is not a regular file of yours; the window's output is not kept`);
      return null;
    }
    fs.fchmodSync(fd, 0o600);
    fs.ftruncateSync(fd, 0);
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    say(`no log: cannot prepare ${log} (${e.code ?? e.message}); the window's output is not kept`);
    return null;
  }
}

/**
 * `--detach`: re-spawn this launcher in its own session with output to the log, wait for its window, print the URL.
 * The URL is printed only once the registry has the window (the entry of our detached launcher, verified by /info),
 * or, if the detached launcher gave way to a window already open on the folder, that window's verified entry.
 */
async function detach(o, argv, autoPort, buildOutput) {
  const log = path.join(os.tmpdir(), `nota-bene-${o.port}.log`);
  const fd = openLog(log);
  if (fd !== null && buildOutput) fs.writeSync(fd, buildOutput);
  const args = argv.filter((a) => a !== '--detach');
  if (autoPort) args.push('--port', String(o.port));
  const child = spawn(process.execPath, [SELF, ...args], {
    detached: true,
    stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    // the parent holds the folder's launch lock until the URL is printed; the child must not wait for it
    env: { ...process.env, NOTA_BENE_LOCKED: '1', ...(autoPort ? { NOTA_BENE_AUTOPORT: '1' } : {}) },
  });
  if (fd !== null) fs.closeSync(fd);
  let exitCode;
  child.on('exit', (code, signal) => (exitCode = code ?? signal));
  child.unref();

  const end = Date.now() + DETACH_WAIT_MS;
  while (Date.now() < end) {
    const gone = exitCode !== undefined;
    for (const [key, w] of Object.entries(readWindows())) {
      if (w.root !== o.dir || !(w.launcherPid === child.pid || (gone && exitCode === 0 && pidAlive(w.pid)))) continue;
      if ((await probeInfo(Number(key)))?.root === o.dir) {
        // ours, or the window our launcher gave way to (it lost a port race to a launcher of the same folder)
        process.stdout.write(`${w.launcherPid === child.pid ? 'opened' : 'already-open'} ${(await loginTarget(`http://127.0.0.1:${key}`)) ?? `http://127.0.0.1:${key}`}\n`);
        return 0;
      }
    }
    if (gone) break;
    await sleep(250);
  }
  if (exitCode === undefined) {
    // timed out: stop the detached launcher and its server before our caller releases the folder's lock
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  say(exitCode !== undefined
    ? `the server did not come up (launcher exited: ${exitCode}). Last log lines:`
    : `the server did not come up in ${DETACH_WAIT_MS / 1000}s. Last log lines:`);
  if (fd !== null) process.stderr.write(tail(fs.readFileSync(log, 'utf8')));
  return 1;
}

function tail(text, n = 15) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).map((l) => `${l}\n`).join('');
}

/** The supervisor loop. Resolves with the launcher's exit code; the window's registry entry goes with it. */
async function run(o, autoPort, release = () => {}) {
  const state = { port: o.port, pid: undefined };
  try {
    return await supervise(o, autoPort, release, state);
  } finally {
    if (state.pid !== undefined) dropEntry(state.port, state.pid);
  }
}

/** Removes the port's entry if it is this launcher's: its last child's, or an earlier child's kept through a restart. */
function dropEntry(port, pid) {
  try {
    const w = entryOf(port);
    unregisterWindow(port, w?.launcherPid === process.pid ? w.pid : pid);
  } catch (e) {
    say(`cannot update the window registry: ${e.message}`);
  }
}

/**
 * A foreground launcher (the /nb background task) stops when the shell that started it is gone (it was SIGKILLed
 * without its children): ppid changes, checked every 2 s, and the child is stopped as on SIGTERM. Not for a detached
 * child (NOTA_BENE_LOCKED: its parent exits by design) or a launcher already reparented at start (ppid 1).
 */
function watchParent(onSignal, everyMs = 2000) {
  const parent = process.ppid;
  if (process.env.NOTA_BENE_LOCKED === '1' || parent === 1) return;
  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    clearInterval(timer);
    // the shell's output pipe may be gone with it: a failed write must not crash the shutdown
    for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
    say(`the parent process (pid ${parent}) is gone — stopping`);
    onSignal('SIGTERM');
  }, everyMs);
  timer.unref();
}

async function supervise(o, autoPort, release, state) {
  let port = o.port;
  let dir = o.dir; // follows the window's in-app folder switches (its registry entry), so a relaunch reopens it
  let child = null;
  let stopping = false;
  let wake = null; // cuts the 1 s crash pause short on a signal
  const onSignal = (sig) => {
    if (stopping) return;
    stopping = true;
    if (child) child.kill(sig);
    else wake?.();
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
  watchParent(onSignal);

  const crashes = [];
  const restarts = [];
  const recent = (list) => {
    const now = Date.now();
    while (list.length && now - list[0] >= GUARD_WINDOW_MS) list.shift();
    list.push(now);
    return list.length;
  };
  let first = true;
  let retried = false;
  // this launch's nonce (public; server/src/auth.ts): every server this launcher starts or relaunches gets the same one, so a
  // restart keeps open tabs logged in while a value captured from an earlier launch is dead
  // Exit 75 (the user's restart) keeps it; after a crash it is replaced and the browser is opened on a fresh login, so whatever
  // the crashed launch handed out (a leaked URL, a cookie) dies with it
  let nonce = newNonce();
  let crashed = false;
  for (;;) {
    if (crashed) {
      nonce = newNonce();
    }
    const env = serverEnv(process.env, process.pid);
    env.NOTA_BENE_NONCE = nonce;
    delete env.NOTA_BENE_AUTOPORT;
    delete env.NOTA_BENE_LOCKED;
    const c = spawn(process.execPath, [MAIN, ...serverArgs({ ...o, dir }, port, !first)], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child = c;
    state.pid = c.pid;
    const exited = new Promise((resolve) => c.on('exit', (code, signal) => resolve({ code, signal })));
    let done = false;
    void exited.then(() => (done = true));

    // register once /info answers; the root comes from the server, which re-registers itself on a folder switch
    while (!done) {
      const got = await probeInfo(port);
      if (got && !done) {
        try {
          registerWindow(port, got.root, c.pid, process.pid);
        } catch (e) {
          say(`cannot register the window: ${e.message}`); // the window works without it; --find falls back
        }
        release(); // registered: a later launch on the folder finds this window
        if ((first || crashed) && o.open && !stopping) void openBrowser(`http://127.0.0.1:${port}`).catch(() => {});
        crashed = false;
        break;
      }
      await Promise.race([sleep(250), exited]);
    }
    const { code, signal } = await exited;
    child = null;
    // the entry stays (pid dead, launcher alive = restarting) so no other launch takes the port before the relaunch
    const w = entryOf(port);
    if (w?.pid === c.pid && w.root !== dir && fs.existsSync(w.root)) dir = w.root;
    if (stopping) return 0;

    if (!first && code === LISTEN_FAILED) {
      say(`port ${port} was taken during the restart — giving up`);
      return LISTEN_FAILED;
    }

    if (first && code === LISTEN_FAILED) {
      if (!autoPort || retried) {
        say(`port ${port} is in use`);
        return LISTEN_FAILED;
      }
      // the bind test passed, then another launcher took the port first: if it serves this folder, it is ours
      const holder = await probeInfo(port, 1000);
      if (holder?.root === dir) {
        if (o.open) await openBrowser(`http://127.0.0.1:${port}`); // bring it to front
        process.stdout.write(`nota-bene: already open at http://127.0.0.1:${port}\n`);
        return 0;
      }
      const next = await firstFreePort(new Set([port]));
      if (stopping) return 0;
      if (next === null) {
        say(`port ${port} was taken and there is no other free port in ${portRange().join('–')}`);
        return LISTEN_FAILED;
      }
      say(`port ${port} was taken meanwhile, retrying on ${next}`);
      dropEntry(port, c.pid); // a holder's /info may have got us registered there
      port = next;
      state.port = next;
      retried = true;
      continue; // still the first start: the original --resume/--fork/--new apply
    }

    if (code === NO_AGENT_BINARY) return code;

    if (code === RESTART) {
      const n = recent(restarts);
      if (n > MAX_RESTARTS) {
        say(`server asked for ${n} restarts in the last minute — restarting in a loop, giving up`);
        return RESTART;
      }
    } else if (code !== null && CLEAN_EXITS.has(code)) {
      return code;
    } else {
      const n = recent(crashes);
      const how = code !== null ? `with code ${code}` : `by ${signal}`;
      if (n >= MAX_CRASHES) {
        say(`server exited ${how} (${n} crashes in the last minute) — crashing in a loop, giving up`);
        return code ?? 128 + (os.constants.signals[signal] ?? 0);
      }
      say(`server exited ${how} — relaunching (${n} crash(es) in the last minute)`);
      crashed = true;
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 1000);
      });
      wake = null;
      if (stopping) return 0;
    }
    first = false;
  }
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (o.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  process.env.NOTA_BENE_AGENT = o.agent ?? 'claude';
  try {
    if (o.find !== undefined) return await find(o.find, o.scan);
    if (o.last !== undefined) return last(o.last);
    if (o.url !== undefined || o.front !== undefined) {
      const base = baseUrlOf(o.url ?? o.front);
      if (!base) {
        say(`not a window port or a loopback URL: ${o.url ?? o.front}`);
        return 2;
      }
      const url = await loginTarget(base);
      if (!url) {
        say(`nothing on ${base} proved it is a Nota Bene ${base.includes('localhost') ? `dev page (backend on ${DEV_BACKEND_PORT})` : 'window'} of this state dir`);
        return 1;
      }
      // the login value dies with that window's launcher: a URL kept from earlier needs a new --url
      if (o.url !== undefined) process.stdout.write(`${url}\n`);
      else if (!(await openBrowser(base))) {
        say(`the browser could not be opened; run \`nota-bene --url ${new URL(base).port}\` and open the URL it prints`);
        return 1;
      }
      return 0;
    }
    o.dir = realDir(o.dir ?? '.');
  } catch (e) {
    say(e.message);
    return e instanceof SecretError ? EXIT_SECRET : 1;
  }
  if (refuse(o.dir)) {
    say(`refusing to open the whole ${o.dir} as a project — cd into a project first.`);
    return 1;
  }
  // the secrets, before any spawn: a refused one is reported once here, never as a crash loop of servers that die on it
  try {
    accessToken();
    stateSecret('control-token');
  } catch (e) {
    say(e.message);
    return 1;
  }
  // build first, pick the port after: a long build must not widen the race between the bind test and the listen
  let buildOutput = '';
  try {
    buildOutput = ensureBuild(REPO, process.env, o.detach ? 'pipe' : 'inherit'); // --detach: stdout stays one line
  } catch (e) {
    say(e.message);
    if (e.output) process.stderr.write(tail(e.output));
    return 1;
  }
  // one window per folder: wait for any launch in progress on it, then give way to a window already serving it
  const locked = process.env.NOTA_BENE_LOCKED === '1'; // a detached child: the parent holds the lock and checked
  const release = locked ? () => {} : await acquireLaunchLock(o.dir);
  try {
    if (!locked) {
      const port = await servingWindow(o.dir);
      if (port !== undefined) {
        const url = `http://127.0.0.1:${port}`;
        if (o.open) await openBrowser(url); // bring it to front
        process.stdout.write(o.detach ? `already-open ${(await loginTarget(url)) ?? url}\n` : `nota-bene: already open at ${url}\n`);
        return 0;
      }
    }
    return await launch(o, argv, buildOutput, release);
  } finally {
    release();
  }
}

async function launch(o, argv, buildOutput, release) {
  const picked = o.port === undefined;
  // a detached launcher gets its port from the parent's pick (NOTA_BENE_AUTOPORT), so it may still retry once on a race
  const autoPort = picked || process.env.NOTA_BENE_AUTOPORT === '1';
  if (picked) {
    o.port = await firstFreePort();
    if (o.port === null) {
      say(`no free port in ${portRange().join('–')}`);
      return 1;
    }
  }
  if (o.detach) return detach(o, argv, picked, buildOutput);
  return run(o, autoPort, release);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      say(e instanceof Error ? e.stack ?? e.message : String(e));
      process.exit(1);
    },
  );
}
