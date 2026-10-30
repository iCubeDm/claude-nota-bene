// The local access token: nothing on the machine reaches the API or the socket without it.
//
// One secret per state dir (`<stateDir>/token`, 32 random bytes as hex, mode 600, created with an exclusive link so two
// first launches agree). It never travels in argv, env or a log: the server and the helpers read the file. A browser logs
// in once with the token (the URL fragment `#t=`, POSTed to /auth) and keeps an HttpOnly cookie. The cookie and the
// helpers' Authorization header carry a per-port credential (an HMAC of the port keyed by the token), not the token. The
// credential is stable: it works for any window that ever binds that port, so it must NEVER go to a port whose listener has
// not proved itself. A helper first asks the public GET /hello?c=<random> and checks the proof (an HMAC of the port and c
// keyed by the token, which only a holder of the token file can make); only then does it send the Bearer (verifiedBearer).
// The token is readable by any process of the same OS user (the agent too): the aim is to shut out other users
// and software that cannot read the file, not the user's own tools.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { stateDir } from './state.ts';

const TOKEN_RE = /^[0-9a-f]{64}$/;
/** how long a browser keeps its login (a year); deleting the token file rotates it at the next server start */
export const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

/** A secret kept in `<stateDir>/<name>`: read, or created once (mode 600). Concurrent first callers get one value. */
export function stateSecret(name: string): string {
  const dir = stateDir();
  const file = path.join(dir, name);
  const read = () => {
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      return TOKEN_RE.test(t) ? t : null;
    } catch {
      return null;
    }
  };
  const have = read();
  if (have) return have;
  try {
    fs.chmodSync(dir, 0o700); // the state dir holds secrets; best effort (not ours to change, then it stays)
  } catch { /* leave it */ }
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
    const again = read();
    if (again) return again; // the other process's
    fs.renameSync(tmp, file); // a garbage file: replaced atomically
    return t;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The access token of this state dir. */
export const accessToken = (): string => stateSecret('token');

export const cookieName = (port: number): string => `nb_${port}`;

/** What the cookie and the helpers' Bearer carry for a port: it opens that port only, and does not reveal the token. */
export function portCredential(token: string, port: number): string {
  return createHmac('sha256', token).update(`nota-bene:port:${port}`).digest('hex');
}

/** What GET /hello answers for challenge `c` on `port`: it proves knowledge of the token, bound to the port and the challenge. */
export const proofFor = (token: string, port: number, c: string): string =>
  createHmac('sha256', token).update(`nota-bene:proof:${port}:${c}`).digest('hex');

/** A challenge a helper may send: random hex, bounded (the server refuses anything else). */
export const CHALLENGE_RE = /^[0-9a-f]{16,64}$/;

/**
 * `Authorization` value for a window on `port`, or null when the listener there did not prove it holds our token (nothing
 * else is sent to it, and the caller treats the port as not ours). Fresh challenge per call, constant-time comparison.
 */
export async function verifiedBearer(port: number, timeoutMs: number, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const token = accessToken();
    const c = randomBytes(16).toString('hex');
    const r = await fetchFn(`http://127.0.0.1:${port}/hello?c=${c}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    const proof = j && typeof j === 'object' ? (j as { proof?: unknown }).proof : undefined;
    if (typeof proof !== 'string' || !sameSecret(proof, proofFor(token, port, c))) return null;
    return `Bearer ${portCredential(token, port)}`;
  } catch {
    return null;
  }
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

/** A request is authenticated by the port cookie, or `Authorization: Bearer` with the port credential or the raw token. */
export function authenticated(headers: IncomingHttpHeaders, token: string, port: number): boolean {
  const cred = portCredential(token, port);
  if (sameSecret(cookieValue(headers.cookie, cookieName(port)), cred)) return true;
  const m = /^Bearer (\S+)$/i.exec(headers.authorization ?? '');
  return m !== null && (sameSecret(m[1], cred) || sameSecret(m[1], token));
}

/** The Set-Cookie value a successful /auth sends. */
export const sessionCookie = (token: string, port: number): string =>
  `${cookieName(port)}=${portCredential(token, port)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
