// The Settings tab's server side (M6-15): windows, storage, defaults, about. Plus the control routes another window's
// server uses to restart or stop this one.
//
// Cross-window control: a page may only talk to its own server (Origin check), so window A's page asks A's server,
// and A's server relays to B's `/control/<action>` with the per-user control token (`<stateDir>/control-token`,
// mode 600). A browser page never sees the token, so no web page can drive /control; any process of the same user
// could read the file, which is the same trust the state dir already has. A relay goes only to a registered window
// whose pid is alive and whose /info answers with the registered root (a reused port gets nothing, not the token).
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MODES, type Mode } from '@nota-bene/shared';
import { bearerFor, stateSecret } from './auth.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { readPrefs, setDefaultModePref, setLangPref } from './prefs.ts';
import { defaultProjectsDir } from './sessions.ts';
import { stateDir } from './state.ts';
import { pidAlive, readWindows } from './windows.ts';

export const CONTROL_HEADER = 'x-nota-bene-control';
export const CONTROL_ACTIONS = ['restart-agent', 'restart-server', 'stop'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
/** An attachment younger than this is kept by "clean": an open draft may hold it (the server cannot see drafts). */
export const CLEAN_MIN_AGE_MS = 24 * 3600_000;
const ID_RE = /[0-9a-f]{64}/g;

/** The per-user control token, created once (mode 600). */
export const controlToken = (): string => stateSecret('control-token');

export function tokenOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  // latin1: one byte per char as Node decoded the header, so a stray non-ASCII byte cannot make the lengths differ
  const a = Buffer.from(header, 'latin1');
  const b = Buffer.from(token, 'latin1');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bytes and file count under `dir`; symlinks are counted as links, never followed. A missing dir is zero. */
export function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.isFile()) {
        try {
          bytes += fs.lstatSync(p).size;
          files++;
        } catch { /* vanished meanwhile */ }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** Every 64-hex id mentioned in any comments file: conservative (a stray match only keeps more). */
function referencedIds(commentsDir: string): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = fs.readdirSync(commentsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(commentsDir, n), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ID_RE)) out.add(m[0]);
  }
  return out;
}

/**
 * Attachments no comment references and older than CLEAN_MIN_AGE_MS. Session transcripts are not scanned: a replay
 * re-creates any image of its transcript under the same content id, so trashing one loses nothing.
 */
export function cleanCandidates(now = Date.now()): { files: string[]; bytes: number } {
  const dir = path.join(stateDir(), 'attachments');
  const refs = referencedIds(path.join(stateDir(), 'comments'));
  const files: string[] = [];
  let bytes = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { files, bytes };
  }
  for (const n of names) {
    const m = /^([0-9a-f]{64})\.[a-z]+$/.exec(n);
    if (!m || refs.has(m[1]!)) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile() || now - st.mtimeMs < CLEAN_MIN_AGE_MS) continue;
      files.push(n);
      bytes += st.size;
    } catch { /* vanished */ }
  }
  return { files, bytes };
}

/**
 * Moves the candidates to `<stateDir>/trash/attachments/<stamp>/` (never deletes; AttachmentStore.get brings one back
 * when it is read again). A file gone meanwhile is skipped; any other failure is reported, not swallowed.
 */
export function cleanAttachments(now = Date.now()): { moved: number; bytes: number; trash: string; errors: string[] } {
  return moveToTrash('attachments', cleanCandidates(now).files, now);
}

const ARCHIVE_RE = /^([0-9a-zA-Z-]{1,100})\.jsonl$/;

/**
 * Archives (`<stateDir>/history/<id>.jsonl`, R-M7-1) whose session transcript is gone from every project: nothing
 * can resume that session, so nothing can page its archive in. A projects dir that cannot be read proves nothing
 * (a disk not mounted): then no archive is stale. An archive written within CLEAN_MIN_AGE_MS is never stale either
 * (a window with another CLAUDE_CONFIG_DIR may be writing it). The trash is the safety net for the rest.
 */
export function staleArchives(projectsDir = defaultProjectsDir(), now = Date.now()): { files: string[]; bytes: number } {
  const dir = path.join(stateDir(), 'history');
  const files: string[] = [];
  let bytes = 0;
  let projects: string[];
  let names: string[];
  try {
    projects = fs.readdirSync(projectsDir).map((p) => path.join(projectsDir, p));
    names = fs.readdirSync(dir);
  } catch {
    return { files, bytes };
  }
  for (const n of names) {
    const m = ARCHIVE_RE.exec(n);
    if (!m || projects.some((p) => fs.existsSync(path.join(p, `${m[1]!}.jsonl`)))) continue;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile() || now - st.mtimeMs < CLEAN_MIN_AGE_MS) continue;
      files.push(n);
      bytes += st.size;
    } catch { /* vanished */ }
  }
  return { files, bytes };
}

/** Moves the stale archives to `<stateDir>/trash/history/<stamp>/` (never deletes), as cleanAttachments does. */
export function cleanStaleArchives(projectsDir = defaultProjectsDir(), now = Date.now()): { moved: number; bytes: number; trash: string; errors: string[] } {
  return moveToTrash('history', staleArchives(projectsDir, now).files, now);
}

function moveToTrash(kind: 'attachments' | 'history', files: string[], now: number): { moved: number; bytes: number; trash: string; errors: string[] } {
  const src = path.join(stateDir(), kind);
  const trash = path.join(stateDir(), 'trash', kind, new Date(now).toISOString().replace(/[:.]/g, '-'));
  let moved = 0;
  let bytes = 0;
  const errors: string[] = [];
  if (files.length) fs.mkdirSync(trash, { recursive: true });
  for (const n of files) {
    try {
      const size = fs.lstatSync(path.join(src, n)).size;
      fs.renameSync(path.join(src, n), path.join(trash, n));
      moved++;
      bytes += size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') errors.push(`${n}: ${code ?? String(e)}`); // e.g. EXDEV: the dir on another volume
    }
  }
  return { moved, bytes, trash, errors };
}

export type WindowInfo = { root: string; session?: string | null; title?: string | null; supervised?: boolean; busy?: boolean; clients?: number };
export type WindowRow = {
  port: number; root: string; pid: number; startedAt: number; current: boolean;
  /** live: answers with its root; restarting: in a relaunch gap; silent: pid alive, no answer; stale: gone */
  state: 'live' | 'restarting' | 'silent' | 'stale';
  session: string | null; title: string | null; supervised: boolean; busy: boolean; clients: number;
};

export async function probeWindow(port: number, timeoutMs = 700): Promise<WindowInfo | null> {
  try {
    // never follow a redirect: the answer must be that port's own
    const r = await fetch(`http://127.0.0.1:${port}/info`, { headers: { authorization: bearerFor(port) }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const j = (await r.json()) as WindowInfo;
    return j && typeof j.root === 'string' ? j : null;
  } catch {
    return null;
  }
}

export async function listWindows(own: number, probe = probeWindow): Promise<WindowRow[]> {
  const rows = await Promise.all(Object.entries(readWindows()).map(async ([key, w]): Promise<WindowRow> => {
    const port = Number(key);
    const alive = pidAlive(w.pid);
    const info = alive ? await probe(port) : null;
    const state: WindowRow['state'] = !alive
      ? (w.launcherPid !== undefined && pidAlive(w.launcherPid) ? 'restarting' : 'stale')
      : info && info.root === w.root ? 'live' : 'silent';
    const live = state === 'live' && info;
    return {
      port, root: w.root, pid: w.pid, startedAt: w.startedAt, current: port === own, state,
      session: live ? info.session ?? null : null, title: live ? info.title ?? null : null,
      supervised: live ? !!info.supervised : false, busy: live ? !!info.busy : false, clients: live ? info.clients ?? 0 : 0,
    };
  }));
  return rows.sort((a, b) => a.port - b.port);
}

/**
 * The version About shows. A git checkout (`.git` right in `dir`, a directory or a worktree's file) says `git describe`;
 * an installed package has no checkout, so it says its own package.json version. Never `git describe` there: it would
 * describe whatever repository the install happens to sit in.
 */
export function describeVersion(dir: string): Promise<string> {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    try {
      const v = (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
      return Promise.resolve(typeof v === 'string' && v ? v : 'unknown');
    } catch {
      return Promise.resolve('unknown');
    }
  }
  return new Promise((resolve) => {
    execFile('git', ['describe', '--tags', '--always', '--dirty'], { cwd: dir, timeout: 3000 }, (e, out) => resolve(e ? 'unknown' : out.trim()));
  });
}

// once per process: the checkout does not change under a running server in a way About must follow, and a page
// looping requests at /system/about must not spawn a git per request
let version: Promise<string> | null = null;
const gitDescribe = (dir: string): Promise<string> => (version ??= describeVersion(dir));

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
const only = (method: string, req: IncomingMessage, res: ServerResponse): boolean => {
  if (req.method === method || (method === 'GET' && req.method === 'HEAD')) return true;
  text(res, 405, 'method not allowed', { allow: method === 'GET' ? 'GET, HEAD' : method });
  return false;
};
const MAX_BODY = 4096;
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  const v: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SyntaxError('not an object');
  return v;
}

export function systemRoutes(o: {
  hub: EventHub;
  /** the current project root (a switch changes it) */
  root: () => string;
  /** this server's port (known after listen) */
  port: () => number;
  /** the checkout the server runs from, for the version */
  repoDir: string;
  /** run after the reply is out; `supervised` says whether restart-server can be caught by a launcher */
  control: { supervised(): boolean; exiting(): boolean; restartAgent(): void; restartServer(): void; stop(): void };
  probe?: (port: number) => Promise<WindowInfo | null>;
  relay?: (port: number, action: ControlAction, token: string) => Promise<number>;
}): Record<string, RequestListener> {
  const probe = o.probe ?? probeWindow;
  const relay = o.relay ?? (async (port, action, token) => {
    // redirect: 'error': a 307/308 would carry the token on to wherever it points
    const r = await fetch(`http://127.0.0.1:${port}/control/${action}`, { method: 'POST', headers: { [CONTROL_HEADER]: token }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    return r.status;
  });
  const fail = (res: ServerResponse, where: string, e: unknown) => {
    reportError(o.hub, where, e);
    if (!res.headersSent) text(res, 500, 'internal error');
  };

  return {
    '/system/about': (req, res) => {
      if (!only('GET', req, res)) return;
      const port = o.port();
      const log = path.join(os.tmpdir(), `nota-bene-${port}.log`);
      void gitDescribe(o.repoDir).then((version) => json(res, 200, {
        version, stateDir: stateDir(), logs: fs.existsSync(log) ? [log] : [], node: process.version, pid: process.pid,
      }), (e) => fail(res, '/system/about', e));
    },

    '/system/prefs': (req, res) => {
      if (req.method === 'POST') {
        void readJson(req).then((b) => {
          const { defaultMode: mode, lang, ifUnset } = b as { defaultMode?: unknown; lang?: unknown; ifUnset?: unknown };
          if (mode === undefined && lang === undefined) return text(res, 400, 'bad defaultMode');
          if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode)) return text(res, 400, 'bad defaultMode');
          if (lang !== undefined && lang !== 'ru' && lang !== 'en') return text(res, 400, 'bad lang');
          if (mode !== undefined) setDefaultModePref(mode as Mode);
          if (lang !== undefined) setLangPref(lang, ifUnset === true);
          json(res, 200, { ...(mode !== undefined ? { defaultMode: mode } : {}), ...(lang !== undefined ? { lang: readPrefs().lang ?? lang } : {}) });
        }).catch((e: unknown) => (e instanceof SyntaxError || (e instanceof Error && e.message === 'body too large') ? text(res, 400, 'bad request') : fail(res, '/system/prefs', e)));
        return;
      }
      if (!only('GET', req, res)) return;
      json(res, 200, { defaultMode: readPrefs().defaultMode ?? 'auto' });
    },

    '/system/storage': (req, res) => {
      if (!only('GET', req, res)) return;
      try {
        const sd = stateDir();
        const c = cleanCandidates();
        const h = staleArchives();
        json(res, 200, {
          attachments: dirSize(path.join(sd, 'attachments')),
          comments: dirSize(path.join(sd, 'comments')),
          history: dirSize(path.join(sd, 'history')),
          trash: dirSize(path.join(sd, 'trash')),
          marks: { ...dirSize(path.join(o.root(), '.nota-bene', 'marks')), root: o.root() },
          // what "clean" moves: unreferenced pasted images and the archives of deleted sessions
          unreferenced: { files: c.files.length + h.files.length, bytes: c.bytes + h.bytes },
        });
      } catch (e) {
        fail(res, '/system/storage', e);
      }
    },

    '/system/storage/clean': (req, res) => {
      if (!only('POST', req, res)) return;
      try {
        const a = cleanAttachments();
        const h = cleanStaleArchives();
        const trash = a.moved && h.moved ? path.join(stateDir(), 'trash') : h.moved ? h.trash : a.trash;
        json(res, 200, { moved: a.moved + h.moved, bytes: a.bytes + h.bytes, trash, errors: [...a.errors, ...h.errors] });
      } catch (e) {
        fail(res, '/system/storage/clean', e);
      }
    },

    '/system/windows': (req, res) => {
      if (!only('GET', req, res)) return;
      listWindows(o.port(), probe).then((rows) => json(res, 200, rows), (e) => fail(res, '/system/windows', e));
    },

    '/system/windows/action': (req, res) => {
      if (!only('POST', req, res)) return;
      void readJson(req).then(async (b) => {
        const { port, action, root, pid, startedAt } = b as { port?: unknown; action?: unknown; root?: unknown; pid?: unknown; startedAt?: unknown };
        if (!Number.isInteger(port) || !(CONTROL_ACTIONS as readonly unknown[]).includes(action)) return text(res, 400, 'bad request');
        if (port === o.port()) return text(res, 409, 'this window'); // its own controls are in its header
        const w = readWindows()[String(port)];
        if (!w || !pidAlive(w.pid)) return text(res, 404, 'no such window');
        // the window the user saw (and confirmed) must still be the one on that port: a port reused by a newer window
        // after the list was loaded is not touched
        if (w.root !== root || w.pid !== pid || w.startedAt !== startedAt) return text(res, 409, 'window changed');
        const info = await probe(port as number);
        if (!info || info.root !== w.root) return text(res, 409, 'window not answering');
        const status = await relay(port as number, action as ControlAction, controlToken());
        json(res, status === 200 ? 200 : 502, { status });
      }).catch((e: unknown) => (e instanceof SyntaxError || (e instanceof Error && e.message === 'body too large') ? text(res, 400, 'bad request') : fail(res, '/system/windows/action', e)));
    },

    // reached only with the control token (http.ts lets /control/ through without an Origin when the token matches)
    '/control/': (req, res) => {
      if (!only('POST', req, res)) return;
      const action = (req.url ?? '').split('?')[0]!.slice('/control/'.length) as ControlAction;
      if (!CONTROL_ACTIONS.includes(action)) return text(res, 404, 'not found');
      if (o.control.exiting()) return text(res, 409, 'exiting'); // a stop or restart is already under way
      if (action === 'restart-server' && !o.control.supervised()) return text(res, 409, 'not supervised');
      // answer first: a restart or stop must not cut the reply
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}', () => {
        if (action === 'restart-agent') o.control.restartAgent();
        else if (action === 'restart-server') o.control.restartServer();
        else o.control.stop();
      });
    },
  };
}
