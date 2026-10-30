// The local access token: nothing on the machine reaches the API or the socket without it.
//
// One secret per state dir (`<stateDir>/token`, 32 random bytes as hex, mode 600, created with an exclusive link so two
// first launches agree). It never travels in argv, env or a log: the server and the helpers read the file.
//
// Everything a client holds is derived from the token, the port AND a per-launch nonce (the launcher makes it and passes it
// to every server it starts, so exit 75 and crash relaunches keep it; an unsupervised server makes its own). The nonce is
// public, not a secret. A value captured from one launch is dead at the next, and one captured for a port is dead on any
// other. Derived values, each with its own label:
//   cookie  `nb_<port>`      HttpOnly, opens GET routes only (file views, images, media): a browser sends it to every
//                            port on 127.0.0.1, so on its own it must not open the socket or any write
//   key                      what the page keeps in localStorage (origin-scoped, port included); with the cookie it opens
//                            /ws and every non-GET route (header `x-nota-bene-key`, or the `nb.<key>` WebSocket subprotocol)
//   helper bearer            what a helper sends as Authorization: both tiers
//   proof                    what GET /hello answers for a challenge: a helper sends nothing (not even a derived value)
//                            to a port until its listener proves it holds the token (verifiedBearer)
// The raw token as a Bearer also opens both tiers (a script of the user's own). The token is readable by any process of the
// same OS user (the agent too): the aim is to shut out other users and software that cannot read the file.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { stateDir } from './state.ts';

const TOKEN_RE = /^[0-9a-f]{64}$/;
/** how long a browser keeps its login (a year); deleting the token file rotates it at the next server start */
export const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

/**
 * Reads a state secret, fail-closed: a file owned by another user is refused (throws), one readable by group or other is
 * treated as leaked (null: the caller rotates it), and only ENOENT means "none yet". Any other read error throws: a token must
 * never be replaced because it could not be read.
 */
function readSecret(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (process.getuid && st.uid !== process.getuid()) {
      throw new Error(`${file} belongs to another user (uid ${st.uid}); refusing to use it. Remove it or point NOTA_BENE_HOME at a folder of your own`);
    }
    if (st.mode & 0o077) return null; // readable by group or other: not a secret any more, rotate
    const t = fs.readFileSync(fd, 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** A secret kept in `<stateDir>/<name>`: read, or created once (mode 600). Concurrent first callers get one value. */
export function stateSecret(name: string): string {
  const dir = stateDir();
  const file = path.join(dir, name);
  const have = readSecret(file);
  if (have) return have;
  const t = randomBytes(32).toString('hex');
  // written whole to a tmp file, then linked in: the name appears only with its content (no reader sees it empty),
  // and the link fails if another process got there first
  const tmp = `${file}.tmp${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, t, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return t;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const again = readSecret(file);
    if (again) return again; // the other process's
    fs.renameSync(tmp, file); // a garbage or loose file: replaced atomically
    return t;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The access token of this state dir. */
export const accessToken = (): string => stateSecret('token');

export const cookieName = (port: number): string => `nb_${port}`;

const NONCE_RE = /^[0-9a-f]{32}$/;
export const isNonce = (n: unknown): n is string => typeof n === 'string' && NONCE_RE.test(n);
export const newNonce = (): string => randomBytes(16).toString('hex');

const mac = (token: string, label: string, port: number, nonce: string): string =>
  createHmac('sha256', token).update(`nota-bene:${label}:${port}:${nonce}`).digest('hex');
/** the HttpOnly cookie's value: read tier */
export const cookieCredential = (token: string, port: number, nonce: string): string => mac(token, 'cookie', port, nonce);
/** the page's key: with the cookie, write tier */
export const keyCredential = (token: string, port: number, nonce: string): string => mac(token, 'key', port, nonce);
/** a helper's Authorization: both tiers */
export const helperCredential = (token: string, port: number, nonce: string): string => mac(token, 'helper', port, nonce);

/** What GET /hello answers for challenge `c` on `port` in launch `n`: proves knowledge of the token, bound to all three. */
export const proofFor = (token: string, port: number, n: string, c: string): string =>
  createHmac('sha256', token).update(`nota-bene:proof:${port}:${n}:${c}`).digest('hex');

/** A challenge a helper may send: random hex, bounded (the server refuses anything else). */
export const CHALLENGE_RE = /^[0-9a-f]{16,64}$/;

export const KEY_HEADER = 'x-nota-bene-key';
export const KEY_PROTOCOL = 'nb.';

/**
 * Asks `host:dial` to prove it is a window of this state dir whose proof is bound to `bound` (the port it is listening on; for
 * the dev proxy that is the backend's, not the one dialled). Returns the launch nonce of a checked proof, else null. A bad or
 * missing proof means "not ours": the caller sends nothing. Fresh challenge per call, constant-time comparison.
 */
export async function proveListener(o: { dial: number; bound?: number; host?: string; timeoutMs: number; fetchFn?: typeof fetch }): Promise<string | null> {
  try {
    const token = accessToken();
    const c = randomBytes(16).toString('hex');
    const r = await (o.fetchFn ?? fetch)(`http://${o.host ?? '127.0.0.1'}:${o.dial}/hello?c=${c}`, { signal: AbortSignal.timeout(o.timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const j = (await r.json()) as { proof?: unknown; n?: unknown } | null;
    if (!j || typeof j.proof !== 'string' || !isNonce(j.n)) return null;
    return sameSecret(j.proof, proofFor(token, o.bound ?? o.dial, j.n, c)) ? j.n : null;
  } catch {
    return null;
  }
}

/** `Authorization` value for a window on `port`, or null when its listener did not prove itself (nothing is sent to it). */
export async function verifiedBearer(port: number, timeoutMs: number, fetchFn?: typeof fetch): Promise<string | null> {
  const n = await proveListener({ dial: port, timeoutMs, ...(fetchFn ? { fetchFn } : {}) });
  return n === null ? null : `Bearer ${helperCredential(accessToken(), port, n)}`;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
/** Constant-time string equality (both sides hashed first, so length does not leak either). */
export function sameSecret(a: string | undefined, b: string): boolean {
  return a !== undefined && timingSafeEqual(digest(a), digest(b));
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The page's key from a request: the header (fetch) or the `nb.<key>` WebSocket subprotocol (the socket; never the URL). */
function keyOf(headers: IncomingHttpHeaders): string | undefined {
  const h = headers[KEY_HEADER];
  if (typeof h === 'string') return h;
  for (const p of String(headers['sec-websocket-protocol'] ?? '').split(',')) {
    const v = p.trim();
    if (v.startsWith(KEY_PROTOCOL)) return v.slice(KEY_PROTOCOL.length);
  }
  return undefined;
}

/**
 * Authenticated for this launch (`nonce`). A Bearer (the helper's, or the raw token) opens both tiers. The cookie opens the read
 * tier (GET/HEAD routes); `write` (the socket, every other method) also needs the page's key.
 */
export function authenticated(headers: IncomingHttpHeaders, token: string, port: number, nonce: string, write: boolean): boolean {
  const m = /^Bearer (\S+)$/i.exec(headers.authorization ?? '');
  if (m && (sameSecret(m[1], helperCredential(token, port, nonce)) || sameSecret(m[1], token))) return true;
  if (!sameSecret(cookieValue(headers.cookie, cookieName(port)), cookieCredential(token, port, nonce))) return false;
  return !write || sameSecret(keyOf(headers), keyCredential(token, port, nonce));
}

/** The Set-Cookie value a successful /auth sends. */
export const sessionCookie = (token: string, port: number, nonce: string): string =>
  `${cookieName(port)}=${cookieCredential(token, port, nonce)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
