import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import {
  accessToken, authenticated, cookieCredential, cookieRoute, loginCredential, cookieName, helperCredential, keyCredential, proofFor, proveListener, sameSecret,
  sessionCookie, verifiedBearer,
} from './auth.ts';
import { startServer } from './server.ts';
import { controlToken } from './system.ts';
import { shellEnv } from './session/shellText.ts';

// The local access token (B1d): nothing reaches the API or the socket without it. Two tiers: the cookie alone reads (GET/HEAD);
// the socket and every write need the page's key too. Every derived value is bound to the port and to the launch's nonce.

let tmp: string;
let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-auth-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(tmp, 'dist'));
  fs.mkdirSync(path.join(tmp, 'proj'));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>shell</h1>');
  fs.writeFileSync(path.join(tmp, 'dist', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(tmp, 'proj', 'a.txt'), 'project file');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.chmodSync(tmp, 0o700);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const N1 = '11'.repeat(16);
const N2 = '22'.repeat(16);

describe('the token file', () => {
  it('is created on first need: 64 hex, mode 600, in a 700 state dir, and reused', () => {
    const t = accessToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(accessToken()).toBe(t);
    expect(fs.statSync(path.join(home, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it('tightens a state dir that exists with a loose mode', () => {
    fs.mkdirSync(home, { mode: 0o755 });
    fs.chmodSync(home, 0o755);
    accessToken();
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it('deleting the file rotates it', () => {
    const t = accessToken();
    fs.rmSync(path.join(home, 'token'));
    expect(accessToken()).not.toBe(t);
  });

  describe('only a missing file makes a token (the ssh rule): everything else throws, names the file and the fix, and changes nothing', () => {
    const file = () => path.join(home, 'token');
    const seed = (content: string, mode = 0o600) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(file(), content, { mode }); fs.chmodSync(file(), mode); };
    const refuses = (re: RegExp) => {
      const err = (() => { try { accessToken(); return null; } catch (e) { return e as Error; } })();
      expect(err?.message).toMatch(re);
      expect(err!.message).toContain(file());
    };

    it('garbage content', () => {
      seed('nope');
      refuses(/does not hold a token/);
      expect(fs.readFileSync(file(), 'utf8')).toBe('nope');
    });

    it('a file readable by group or other (names chmod 600)', () => {
      seed('a'.repeat(64), 0o644);
      refuses(/chmod 600/);
      expect(fs.readFileSync(file(), 'utf8')).toBe('a'.repeat(64)); // not rotated, not rewritten
      fs.chmodSync(file(), 0o640);
      refuses(/readable by other users/);
    });

    it('a file of another user', () => {
      const t = accessToken();
      vi.spyOn(process, 'getuid').mockReturnValue((process.getuid!() + 1) as never);
      refuses(/belongs to another user/);
      vi.restoreAllMocks();
      expect(fs.readFileSync(file(), 'utf8')).toBe(t);
    });

    it.skipIf(process.getuid?.() === 0)('a file that cannot be read', () => {
      const t = accessToken();
      fs.chmodSync(file(), 0o000);
      refuses(/cannot read/);
      fs.chmodSync(file(), 0o600);
      expect(accessToken()).toBe(t);
    });

    it('a directory, a symbolic link (even to a good token) and a FIFO (which must not hang the open)', () => {
      fs.mkdirSync(file(), { recursive: true });
      refuses(/./);
      fs.rmSync(file(), { recursive: true });
      const good = path.join(tmp, 'good-token');
      fs.writeFileSync(good, 'b'.repeat(64), { mode: 0o600 });
      fs.symlinkSync(good, file());
      refuses(/symbolic link/);
      fs.rmSync(file());
      execFileSync('mkfifo', [file()]);
      refuses(/not a regular file/);
    });

    it('the control token follows the same rule', () => {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'control-token'), 'x', { mode: 0o600 });
      expect(() => controlToken()).toThrow(/control-token/);
    });

    it('a state folder of another user is refused', () => {
      vi.spyOn(process, 'getuid').mockReturnValue((process.getuid!() + 1) as never);
      expect(() => accessToken()).toThrow(/belongs to another user/);
    });
  });

  it('several processes starting at once agree on one token', async () => {
    const here = fileURLToPath(new URL('./auth.ts', import.meta.url));
    const run = () => new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', `import { accessToken } from ${JSON.stringify(here)}; process.stdout.write(accessToken());`],
        { env: { ...process.env, NOTA_BENE_HOME: home } }, (e, out) => (e ? reject(e) : resolve(out)));
    });
    const seen = await Promise.all(Array.from({ length: 8 }, run));
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe(accessToken());
  });
});

describe('credentials', () => {
  const token = 'a'.repeat(64);
  it('every value is per port and per launch, has its own label, and does not contain the token', () => {
    const fs4 = [cookieCredential, keyCredential, helperCredential, loginCredential];
    expect(new Set(fs4.map((f) => f(token, 4777, N1))).size).toBe(4);
    for (const f of fs4) {
      expect(f(token, 4777, N1)).toMatch(/^[0-9a-f]{64}$/);
      expect(f(token, 4777, N1)).not.toBe(f(token, 4778, N1));
      expect(f(token, 4777, N1)).not.toBe(f(token, 4777, N2));
      expect(f(token, 4777, N1)).not.toBe(f('b'.repeat(64), 4777, N1));
    }
    expect(proofFor(token, 4777, N1, 'cc'.repeat(8))).not.toBe(proofFor(token, 4777, N2, 'cc'.repeat(8)));
    const c = sessionCookie(token, 4777, N1);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).not.toContain(token);
    expect(cookieName(4777)).not.toBe(cookieName(4778));
  });

  it('authenticated: the cookie opens a cookie route; everything else needs the key too; a Bearer (helper or raw token) opens all', () => {
    const cookie = `nb_4777=${cookieCredential(token, 4777, N1)}`;
    const key = keyCredential(token, 4777, N1);
    const ok = (h: http.IncomingHttpHeaders, needKey: boolean) => authenticated(h, token, 4777, N1, needKey);
    expect(ok({ cookie }, false)).toBe(true);
    expect(ok({ cookie }, true)).toBe(false);
    expect(ok({ cookie, 'x-nota-bene-key': key }, true)).toBe(true);
    expect(ok({ cookie, 'sec-websocket-protocol': `nb.${key}` }, true)).toBe(true);
    expect(ok({ cookie, 'sec-websocket-protocol': `other, nb.${key}` }, true)).toBe(true);
    expect(ok({ 'x-nota-bene-key': key }, false)).toBe(false); // the key alone opens nothing
    expect(ok({ cookie, 'x-nota-bene-key': 'f'.repeat(64) }, true)).toBe(false);
    expect(ok({ cookie, 'x-nota-bene-key': keyCredential(token, 4778, N1) }, true)).toBe(false);
    expect(ok({ cookie, 'x-nota-bene-key': keyCredential(token, 4777, N2) }, true)).toBe(false);
    for (const needKey of [false, true]) {
      expect(ok({ authorization: `Bearer ${helperCredential(token, 4777, N1)}` }, needKey)).toBe(true);
      expect(ok({ authorization: `Bearer ${token}` }, needKey)).toBe(true);
      expect(ok({ authorization: `Bearer ${helperCredential(token, 4777, N2)}` }, needKey)).toBe(false);
      expect(ok({ authorization: `Bearer ${helperCredential(token, 4778, N1)}` }, needKey)).toBe(false);
      expect(ok({ authorization: `Bearer ${cookieCredential(token, 4777, N1)}` }, needKey)).toBe(false); // the cookie's value is not a bearer
      expect(ok({ authorization: `Bearer ${loginCredential(token, 4777, N1)}` }, needKey)).toBe(false); // nor is the login value
      expect(ok({ cookie: `nb_4777=${cookieCredential(token, 4777, N2)}`, 'x-nota-bene-key': key }, needKey)).toBe(false);
      expect(ok({ cookie: `nb_4778=${cookieCredential(token, 4778, N1)}`, 'x-nota-bene-key': key }, needKey)).toBe(false);
      expect(ok({}, needKey)).toBe(false);
    }
  });

  it('cookieRoute: only GET/HEAD of /file and /attach/<id>; a new route is in the key tier by default', () => {
    expect(cookieRoute('GET', '/file')).toBe(true);
    expect(cookieRoute('HEAD', '/file')).toBe(true);
    expect(cookieRoute('GET', '/attach/' + 'a'.repeat(64))).toBe(true);
    for (const [m, p] of [['POST', '/file'], ['POST', '/attach'], ['POST', '/attach/x'], ['GET', '/attach/'], ['GET', '/attach'], ['GET', '/model'], ['GET', '/tmpimage'], ['HEAD', '/tmpimage'], ['GET', '/info'], ['GET', '/tree'],
      ['GET', '/sessions'], ['GET', '/anything-new'], ['GET', '/file/x'], ['GET', '/filesystem'], ['GET', '/ws'], ['DELETE', '/attach/x'], [undefined, '/file']] as const) {
      expect(cookieRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it('compares secrets of any length without throwing', () => {
    expect(sameSecret('a', 'abc')).toBe(false);
    expect(sameSecret(undefined, 'abc')).toBe(false);
    expect(sameSecret('abc', 'abc')).toBe(true);
  });
});

async function boot(o: { allowedOrigins?: string[]; oneTab?: boolean; nonce?: string; port?: number } = {}) {
  const { port: want, ...rest } = o;
  const s = await startServer({
    cwd: path.join(tmp, 'proj'), port: want ?? 0, backend: fakeBackend([{ text: 'hello' }]), webDist: path.join(tmp, 'dist'),
    takeoverGraceMs: 40, ...rest,
  });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  const token = accessToken();
  const nonce = o.nonce ?? '';
  return {
    ...s, port, token, nonce, origin: `http://127.0.0.1:${port}`,
    cookie: `${cookieName(port)}=${cookieCredential(token, port, nonce)}`,
    key: keyCredential(token, port, nonce),
    helper: helperCredential(token, port, nonce),
  };
}
type Booted = Awaited<ReturnType<typeof boot>>;

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function req(port: number, p: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

// resolves with the first frame, or the HTTP status of a refused upgrade
function wsTry(url: string, headers: Record<string, string> = {}, protocols?: string[]): Promise<{ ws: WebSocket; frame?: string; status?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws', protocols ?? [], { headers });
    closers.push(async () => { ws.terminate(); });
    ws.once('message', (d) => resolve({ ws, frame: String(d) }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode! }));
    ws.once('error', (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}
/** the page: the cookie, and the key as the subprotocol */
const pageSocket = (s: Booted, key = s.key, cookie = s.cookie) => wsTry(s.url, { cookie, origin: s.origin }, [`nb.${key}`]);

// every route the server has, in the tier it must be in. A route that is not listed here lands in the key tier by default (the
// "unlisted" row); adding one to the cookie tier is a decision that has to show up in this table.
const ID = 'a'.repeat(64);
const MATRIX: { method: string; path: string; cookie: 'open' | 'refused' }[] = [
  { method: 'GET', path: '/file?path=a.txt', cookie: 'open' },
  { method: 'HEAD', path: '/file?path=a.txt', cookie: 'open' },
  { method: 'GET', path: `/attach/${ID}`, cookie: 'open' },
  { method: 'HEAD', path: `/attach/${ID}`, cookie: 'open' },
  ...['/info', '/tree?path=', '/complete?q=a', '/sources', '/sessions', '/history?session=x&before=1', '/subagent?session=x&tool=y',
    '/task-output?session=x&task=y', '/git-status', '/system/about', '/system/windows', '/system/storage', '/system/prefs', '/model?path=a.blend', '/tmpimage?path=%2Ftmp%2Fa.png',
    `/marks/${ID}/frame.jpg`].map((path) => ({ method: 'GET', path, cookie: 'refused' as const })),
  { method: 'POST', path: '/attach', cookie: 'refused' },
  { method: 'POST', path: `/attach/${ID}`, cookie: 'refused' },
  { method: 'POST', path: '/file?path=a.txt', cookie: 'refused' },
  { method: 'POST', path: '/restart-server', cookie: 'refused' },
  { method: 'POST', path: '/system/prefs', cookie: 'refused' },
  { method: 'POST', path: '/system/storage/clean', cookie: 'refused' },
  { method: 'POST', path: '/system/windows/action', cookie: 'refused' },
  { method: 'POST', path: `/marks/${ID}/frame.jpg`, cookie: 'refused' },
  { method: 'DELETE', path: `/marks/${ID}`, cookie: 'refused' },
];

describe('the route matrix: each route x no credentials, cookie, cookie plus key', () => {
  it('no credentials: 401 everywhere; the cookie: open only for the cookie routes; cookie plus key: never 401', async () => {
    const s = await boot({ nonce: N1 });
    const call = (m: { method: string; path: string }, headers: Record<string, string>) =>
      req(s.port, m.path, { method: m.method, headers: { origin: s.origin, 'content-type': 'application/json', ...headers }, body: m.method === 'POST' ? '{}' : undefined });
    for (const m of MATRIX) {
      const label = `${m.method} ${m.path}`;
      expect((await call(m, {})).status, `${label}: no credentials`).toBe(401);
      expect((await call(m, { cookie: s.cookie, 'x-nota-bene-key': 'f'.repeat(64) })).status, `${label}: cookie + wrong key`).toBe(m.cookie === 'open' ? (await call(m, { cookie: s.cookie })).status : 401);
      const cookieOnly = (await call(m, { cookie: s.cookie })).status;
      if (m.cookie === 'open') expect(cookieOnly, `${label}: cookie`).not.toBe(401);
      else expect(cookieOnly, `${label}: cookie`).toBe(401);
      expect((await call(m, { cookie: s.cookie, 'x-nota-bene-key': s.key })).status, `${label}: cookie + key`).not.toBe(401);
      expect((await call(m, { authorization: `Bearer ${s.helper}` })).status, `${label}: helper bearer`).not.toBe(401);
    }
  });

  it('the socket: no credentials, cookie, and a wrong key are refused; cookie + key and a bearer are not', async () => {
    const s = await boot({ nonce: N1, oneTab: false });
    expect((await wsTry(s.url)).status).toBe(401);
    expect((await wsTry(s.url, { cookie: s.cookie, origin: s.origin })).status).toBe(401);
    expect((await pageSocket(s, 'f'.repeat(64))).status).toBe(401);
    expect((await pageSocket(s)).frame).toBeDefined();
    expect((await wsTry(s.url, { authorization: `Bearer ${s.helper}` })).frame).toBeDefined();
  });

  it('public: the shell, assets, /auth (POST), /hello; everything else is in the table above', async () => {
    const s = await boot({ nonce: N1 });
    for (const p of ['/', '/app.js', '/some/deep/link']) expect((await req(s.port, p)).status, p).toBe(200);
    expect((await req(s.port, `/hello?c=${'ab'.repeat(16)}`)).status).toBe(200);
    expect((await req(s.port, '/auth', { method: 'POST', headers: { origin: s.origin }, body: '{}' })).status).toBe(401);
  });

  it('the cookie reads project files with Range; the Host check still comes first', async () => {
    const s = await boot({ nonce: N1 });
    expect((await req(s.port, '/file?path=a.txt', { headers: { cookie: s.cookie } })).body).toBe('project file');
    expect((await req(s.port, '/file?path=a.txt', { headers: { cookie: s.cookie, range: 'bytes=0-6' } })).status).toBe(206);
    expect((await req(s.port, '/info', { headers: { host: 'evil.example:1', authorization: `Bearer ${s.helper}` } })).status).toBe(403);
  });

  it('another port\'s or launch\'s credentials open nothing', async () => {
    const s = await boot({ nonce: N1 });
    for (const p of ['/info', '/file?path=a.txt']) {
      expect((await req(s.port, p, { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { authorization: `Bearer ${helperCredential(s.token, s.port, N2)}` } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { cookie: `${cookieName(s.port)}=${cookieCredential(s.token, s.port, N2)}` } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { cookie: `${cookieName(s.port + 1)}=${cookieCredential(s.token, s.port + 1, N1)}` } })).status, p).toBe(401);
    }
  });

  it('a cookie with a forged allowed Origin still cannot write, and a write with the key reaches its route', async () => {
    const s = await boot({ nonce: N1 });
    const h = { cookie: s.cookie, origin: s.origin };
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: h })).status).toBe(401);
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: { ...h, 'x-nota-bene-key': s.key } })).status).toBe(409); // not supervised
    for (const key of [keyCredential(s.token, s.port + 1, N1), keyCredential(s.token, s.port, N2), s.cookie.split('=')[1]!, s.helper]) {
      expect((await req(s.port, '/restart-server', { method: 'POST', headers: { ...h, 'x-nota-bene-key': key } })).status).toBe(401);
    }
  });

  it('a Bearer POST needs no key but still needs an allowed Origin: a foreign one and none at all are 403', async () => {
    const s = await boot({ nonce: N1 });
    const auth = { authorization: `Bearer ${s.helper}` };
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: { ...auth, origin: s.origin } })).status).toBe(409);
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: auth })).status).toBe(403); // no Origin on a non-GET: refused
  });
});

describe('/auth', () => {
  const login = (s: Booted, value: string, headers: Record<string, string> = {}) =>
    req(s.port, '/auth', { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ login: value }) });
  const loginOf = (s: Booted, nonce = s.nonce, port = s.port) => loginCredential(s.token, port, nonce);

  it('this launch\'s login value sets the cookie and returns the key; together they open the socket', async () => {
    const s = await boot({ nonce: N1 });
    const r = await login(s, loginOf(s));
    expect(r.status).toBe(200);
    const set = String(r.headers['set-cookie']);
    expect(set).toContain(s.cookie);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=\d{6,}/);
    expect(JSON.parse(r.body)).toEqual({ ok: true, key: s.key });
    expect(r.body + set).not.toContain(s.token);
    expect(r.body).not.toContain(s.cookie.split('=')[1]!);
    expect((await pageSocket(s)).frame).toBeDefined();
  });

  it('the raw token, a derived value in its place, a login value of another launch or port, and a bad body get 401 or 400 and no cookie', async () => {
    const s = await boot({ nonce: N1 });
    for (const v of [s.token, 'f'.repeat(64), s.key, s.helper, s.cookie.split('=')[1]!, loginOf(s, N2), loginOf(s, N1, s.port + 1), '', 'x']) {
      const r = await login(s, v);
      expect(r.status, v).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const raw = await req(s.port, '/auth', { method: 'POST', headers: { origin: s.origin }, body: JSON.stringify({ token: s.token }) });
    expect(raw.status).toBe(401); // the old field is not understood
    expect((await req(s.port, '/auth', { method: 'POST', headers: { origin: s.origin }, body: 'not json' })).status).toBe(400);
  });

  it('a login value that leaked from an earlier launch is dead at the next', async () => {
    const first = await boot({ nonce: N1 });
    const old = loginOf(first);
    const { port } = first;
    await first.close();
    closers.pop();
    const later = await boot({ nonce: N2, port });
    expect((await login(later, old)).status).toBe(401);
    expect((await login(later, loginOf(later))).status).toBe(200);
  });

  it('is a same-origin POST only: no Origin and a foreign Origin are refused even with the right value', async () => {
    const s = await boot({ nonce: N1 });
    const none = await req(s.port, '/auth', { method: 'POST', body: JSON.stringify({ login: loginOf(s) }) });
    expect(none.status).toBe(403);
    expect(none.headers['set-cookie']).toBeUndefined();
    expect((await login(s, loginOf(s), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await req(s.port, '/auth')).status).toBe(405);
  });
});

describe('the socket', () => {
  it('no auth: refused before any event, with or without an Origin', async () => {
    const s = await boot({ nonce: N1 });
    for (const headers of [{} as Record<string, string>, { origin: s.origin }]) {
      const r = await wsTry(s.url, headers);
      expect(r.status).toBe(401);
      expect(r.frame).toBeUndefined();
    }
    expect((await wsTry(s.url, { authorization: 'Bearer ' + 'e'.repeat(64) })).status).toBe(401);
  });

  it('the cookie alone is refused with no frames, with the page\'s Origin, a forged allowed Origin, or none', async () => {
    const s = await boot({ nonce: N1 });
    const attempts: Record<string, string>[] = [{ cookie: s.cookie, origin: s.origin }, { cookie: s.cookie }, { cookie: s.cookie, origin: `http://localhost:${s.port}` }];
    for (const headers of attempts) {
      const r = await wsTry(s.url, headers);
      expect(r.status).toBe(401);
      expect(r.frame).toBeUndefined();
    }
  });

  it('cookie + key opens it; a wrong key, or the key of another port or launch, does not', async () => {
    const s = await boot({ nonce: N1, oneTab: false });
    const ok = await pageSocket(s);
    expect(ok.frame).toBeDefined();
    expect(ok.ws.protocol).toBe(`nb.${s.key}`); // echoed, or a browser would drop the socket
    for (const key of ['f'.repeat(64), keyCredential(s.token, s.port + 1, N1), keyCredential(s.token, s.port, N2)]) {
      expect((await pageSocket(s, key)).status, key).toBe(401);
    }
    // the key without the cookie opens nothing
    expect((await pageSocket(s, s.key, '')).status).toBe(401);
  });

  it('a foreign Origin is refused even with cookie and key (the Origin check stays)', async () => {
    const s = await boot({ nonce: N1 });
    const r = await wsTry(s.url, { origin: 'https://evil.example', cookie: s.cookie }, [`nb.${s.key}`]);
    expect(r.status).toBe(403);
  });

  it('a helper opens it with Bearer alone', async () => {
    const s = await boot({ nonce: N1, oneTab: false });
    expect((await wsTry(s.url, { authorization: `Bearer ${s.helper}` })).frame).toBeDefined();
  });

  it('the review\'s reproduction: a raw client with the cookie (and a forged Origin) cannot take over or run a command', async () => {
    const s = await boot({ nonce: N1 });
    const owner = await pageSocket(s);
    const events: ServerEvent[] = [];
    owner.ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
    const marker = path.join(tmp, 'pwned');
    for (const headers of [{ cookie: s.cookie, origin: s.origin }, { cookie: s.cookie }, {} as Record<string, string>]) {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(s.url.replace('http', 'ws') + '/ws', { headers });
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'takeover' }));
          ws.send(JSON.stringify({ type: 'shell-run', id: 'x', cmd: `touch ${marker}` }));
        });
        ws.on('error', () => resolve());
        ws.on('unexpected-response', () => resolve());
        ws.on('close', () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(marker)).toBe(false);
    expect(events.some((e) => e.kind === 'taken-over')).toBe(false);
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('oneTab takeover still works for the page (cookie + key)', async () => {
    const s = await boot({ nonce: N1 });
    const first = await pageSocket(s);
    const taken: string[] = [];
    first.ws.on('message', (d) => taken.push(String(d)));
    const second = await pageSocket(s);
    expect(second.frame).toContain('occupied');
    second.ws.send(JSON.stringify({ type: 'takeover' }));
    await new Promise((r) => setTimeout(r, 300));
    expect(taken.join('')).toContain('taken-over');
  });
});

describe('a launch is a boundary: values from an earlier one are dead', () => {
  it('a cookie, key or bearer captured from an earlier launch on the same port is refused by the later window', async () => {
    const first = await boot({ nonce: N1 });
    const { port, cookie, key, helper } = first;
    await first.close();
    closers.pop();
    const later = await boot({ nonce: N2, port });
    expect(later.port).toBe(port);
    for (const p of ['/info', '/file?path=a.txt']) {
      expect((await req(port, p, { headers: { cookie, 'x-nota-bene-key': key } })).status, p).toBe(401);
      expect((await req(port, p, { headers: { authorization: `Bearer ${helper}` } })).status, p).toBe(401);
    }
    expect((await wsTry(later.url, { cookie, origin: later.origin }, [`nb.${key}`])).status).toBe(401);
    expect((await wsTry(later.url, { authorization: `Bearer ${helper}` })).status).toBe(401);
    // the later launch's own values work
    expect((await req(port, '/info', { headers: { cookie: later.cookie, 'x-nota-bene-key': later.key } })).status).toBe(200);
    expect((await pageSocket(later)).frame).toBeDefined();
  });

  it('two servers started with no nonce get different ones', async () => {
    const a = await startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist') });
    const b = await startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: fakeBackend([]), webDist: path.join(tmp, 'dist') });
    closers.push(a.close, b.close);
    const n = async (u: string) => ((await (await fetch(`${u}/hello?c=${'ab'.repeat(16)}`)).json()) as { n: string }).n;
    expect(await n(a.url)).toMatch(/^[0-9a-f]{32}$/);
    expect(await n(a.url)).not.toBe(await n(b.url));
  });
});

describe('/hello, the proof a helper asks for before it trusts a port', () => {
  const C = 'ab'.repeat(16);
  const hello = (port: number, c: string) => req(port, `/hello?c=${c}`);

  it('answers only the proof and the nonce: no root, no credential, no key', async () => {
    const s = await boot({ nonce: N1 });
    const r = await hello(s.port, C);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ proof: proofFor(s.token, s.port, N1, C), n: N1 });
    for (const secret of [s.token, s.helper, s.key, s.cookie.split('=')[1]!, path.join(tmp, 'proj')]) expect(r.body).not.toContain(secret);
  });

  it('a proof for another challenge, port, launch or token does not match', async () => {
    const s = await boot({ nonce: N1 });
    const got = (JSON.parse((await hello(s.port, C)).body) as { proof: string }).proof;
    expect(got).not.toBe(proofFor(s.token, s.port, N1, 'cd'.repeat(16)));
    expect(got).not.toBe(proofFor(s.token, s.port + 1, N1, C));
    expect(got).not.toBe(proofFor(s.token, s.port, N2, C)); // a wrong n
    expect(got).not.toBe(proofFor('f'.repeat(64), s.port, N1, C));
  });

  it('refuses a missing, malformed, short or oversized challenge, and any other method; /info stays protected', async () => {
    const s = await boot({ nonce: N1 });
    for (const c of ['', 'zz'.repeat(16), 'ab', 'ab'.repeat(33), 'AB'.repeat(16), '../x']) expect((await hello(s.port, c)).status, c).toBe(400);
    expect((await req(s.port, '/hello')).status).toBe(400);
    expect((await req(s.port, `/hello?c=${C}`, { method: 'POST', headers: { origin: s.origin } })).status).toBe(405);
    expect((await req(s.port, '/info')).status).toBe(401);
  });

  it('verifiedBearer gives the launch\'s helper credential for a real window, and nothing for a relay of another port\'s window', async () => {
    const real = await boot({ nonce: N1 });
    expect(await verifiedBearer(real.port, 1000)).toBe(`Bearer ${real.helper}`);
    const seen: string[] = [];
    const relay = http.createServer((q, res) => {
      seen.push(`${q.url} ${q.headers.authorization}`);
      req(real.port, q.url ?? '/').then((r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body), () => res.writeHead(502).end());
    });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => { relay.closeAllConnections(); relay.close(() => r()); }));
    const port = (relay.address() as { port: number }).port;
    expect(await verifiedBearer(port, 1000)).toBeNull();
    expect(seen.every((x) => x.endsWith('undefined'))).toBe(true);
  });

  it('proveListener binds the proof to the port it is told (the dev proxy case) and a wrong n fails', async () => {
    const real = await boot({ nonce: N1 });
    expect(await proveListener({ dial: real.port, timeoutMs: 1000 })).toBe(N1);
    expect(await proveListener({ dial: real.port, bound: real.port + 1, timeoutMs: 1000 })).toBeNull();
    // a listener that answers a proof computed with a different n than it reports
    const liar = http.createServer((q, res) => {
      const c = new URL(q.url ?? '/', 'http://x').searchParams.get('c')!;
      const port = (liar.address() as { port: number }).port;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof: proofFor(real.token, port, N1, c), n: N2 }));
    });
    await new Promise<void>((r) => liar.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => { liar.closeAllConnections(); liar.close(() => r()); }));
    expect(await proveListener({ dial: (liar.address() as { port: number }).port, timeoutMs: 1000 })).toBeNull();
  });
});

describe('the helpers send nothing to a listener that cannot prove itself', () => {
  async function impostor(answer?: (url: string) => string | null) {
    const seen: { url: string; auth: string | undefined; cookie: string | undefined }[] = [];
    const srv = http.createServer((q, res) => {
      seen.push({ url: q.url ?? '', auth: q.headers.authorization, cookie: q.headers.cookie });
      const body = answer?.(q.url ?? '');
      if (body === null || body === undefined) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
    return { port: (srv.address() as { port: number }).port, seen };
  }
  const nothingSent = (seen: { auth?: string | undefined; cookie?: string | undefined }[]) => seen.every((x) => x.auth === undefined && x.cookie === undefined);

  it('probeInfo and probeWindow: silent, lying and proof-guessing listeners see no Authorization and no request for /info', async () => {
    const { probeInfo } = await import('./windows.ts');
    const { probeWindow } = await import('./system.ts');
    accessToken();
    for (const answer of [undefined, () => '{"proof":"00","n":"' + N1 + '","root":"/x"}', () => JSON.stringify({ proof: 'ab'.repeat(32), n: N1, root: '/x' })]) {
      const imp = await impostor(answer);
      expect(await probeInfo(imp.port)).toBeNull();
      expect(await probeWindow(imp.port)).toBeNull();
      expect(imp.seen.length).toBeGreaterThan(0);
      expect(nothingSent(imp.seen)).toBe(true);
      expect(imp.seen.every((x) => x.url.startsWith('/hello?c='))).toBe(true);
    }
  });

  it('probeInfo logs in once the window proved itself, and gets nothing from a window of another state dir', async () => {
    const { probeInfo } = await import('./windows.ts');
    const s = await boot({ nonce: N1 });
    expect(await probeInfo(s.port)).toMatchObject({ root: path.join(tmp, 'proj') });
    fs.rmSync(path.join(home, 'token')); // rotated: the running window keeps the old token and cannot prove the new one
    expect(await probeInfo(s.port)).toBeNull();
  });

  it('neither main.ts nor the launcher can switch the check off', () => {
    for (const f of ['main.ts', '../../bin/nota-bene.mjs']) {
      expect(fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')).not.toMatch(/insecureNoAuth|no-auth|NO_AUTH/i);
    }
  });
});

describe('the token and the nonce stay out of what the window runs and prints', () => {
  it('a `!` command and the agent see none of them; logs and /info do not print one', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(' ')));
    const s = await boot({ nonce: N1, oneTab: false });
    process.env.NOTA_BENE_NONCE = N1; // as if the launcher's: shellEnv drops it
    expect(shellEnv(process.env).NOTA_BENE_NONCE).toBeUndefined();
    delete process.env.NOTA_BENE_NONCE;
    const ws = (await wsTry(s.url, { authorization: `Bearer ${s.helper}` })).ws;
    const out: ServerEvent[] = [];
    ws.on('message', (d) => out.push(JSON.parse(String(d)) as ServerEvent));
    ws.send(JSON.stringify({ type: 'shell-run', id: 'e', cmd: 'env; cat "$NOTA_BENE_HOME/token" | wc -c' }));
    let done: Extract<ServerEvent, { kind: 'shell-end' }> | undefined;
    for (let i = 0; i < 300 && !done; i++) {
      done = out.find((x): x is Extract<ServerEvent, { kind: 'shell-end' }> => x.kind === 'shell-end');
      if (!done) await new Promise((r) => setTimeout(r, 20));
    }
    expect(done).toBeDefined();
    const info = (await req(s.port, '/info', { headers: { authorization: `Bearer ${s.helper}` } })).body;
    for (const secret of [s.token, s.helper, s.key, s.cookie.split('=')[1]!]) {
      expect(done!.output).not.toContain(secret);
      expect(JSON.stringify(process.env)).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
      expect(JSON.stringify(out)).not.toContain(secret);
      expect(info).not.toContain(secret);
    }
  });
});

describe('small closings', () => {
  it('an unauthenticated /control/* does not create control-token (it is made at start)', async () => {
    const s = await boot({ nonce: N1 });
    expect(fs.existsSync(path.join(home, 'control-token'))).toBe(true);
    fs.rmSync(path.join(home, 'control-token'));
    for (const headers of [{}, { 'x-nota-bene-control': 'f'.repeat(64) }, { authorization: `Bearer ${s.helper}` }] as Record<string, string>[]) {
      expect((await req(s.port, '/control/stop', { method: 'POST', headers })).status).toBe(403);
    }
    expect(fs.existsSync(path.join(home, 'control-token'))).toBe(false);
  });

  it('the socket is upgraded at /ws only', async () => {
    const s = await boot({ nonce: N1, oneTab: false });
    const at = (p: string) => new Promise<'open' | 'refused'>((resolve) => {
      const ws = new WebSocket(`${s.url.replace('http', 'ws')}${p}`, [`nb.${s.key}`], { headers: { cookie: s.cookie, origin: s.origin } });
      closers.push(async () => { ws.terminate(); });
      ws.once('message', () => resolve('open'));
      ws.once('error', () => resolve('refused'));
      ws.once('unexpected-response', () => resolve('refused'));
      ws.once('close', () => resolve('refused'));
    });
    expect(await at('/ws')).toBe('open');
    expect(await at('/')).toBe('refused');
    expect(await at('/info')).toBe('refused');
    expect(await at('/wsx')).toBe('refused');
  });
});

describe('a refused secret stops the start before the agent exists', () => {
  const touched = () => {
    let n = 0;
    const base = fakeBackend([]);
    return { backend: new Proxy(base, { get(t, k, r) { n++; return Reflect.get(t, k, r); } }), count: () => n };
  };

  it('a loose token file: startServer rejects with the message, the backend is never touched', async () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'token'), 'a'.repeat(64), { mode: 0o644 });
    fs.chmodSync(path.join(home, 'token'), 0o644);
    const b = touched();
    await expect(startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: b.backend, webDist: path.join(tmp, 'dist') })).rejects.toThrow(/readable by other users/);
    expect(b.count()).toBe(0);
  });

  it('a bad control-token too', async () => {
    accessToken();
    fs.writeFileSync(path.join(home, 'control-token'), 'junk', { mode: 0o600 });
    const b = touched();
    await expect(startServer({ cwd: path.join(tmp, 'proj'), port: 0, backend: b.backend, webDist: path.join(tmp, 'dist') })).rejects.toThrow(/control-token/);
    expect(b.count()).toBe(0);
  });

  it('proveListener and the probes let the error through; the garbage-file message says delete, not chmod', async () => {
    const { SecretError } = await import('./auth.ts');
    const { probeInfo } = await import('./windows.ts');
    const { probeWindow } = await import('./system.ts');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'token'), 'junk', { mode: 0o600 });
    await expect(proveListener({ dial: 1, timeoutMs: 100 })).rejects.toBeInstanceOf(SecretError);
    await expect(verifiedBearer(1, 100)).rejects.toBeInstanceOf(SecretError);
    await expect(probeInfo(1)).rejects.toBeInstanceOf(SecretError);
    await expect(probeWindow(1)).rejects.toBeInstanceOf(SecretError);
    const err = (() => { try { accessToken(); return null; } catch (e) { return e as Error; } })();
    expect(err!.message).toMatch(/delete it/);
    expect(err!.message).not.toMatch(/chmod/);
  });
});
