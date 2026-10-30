import { execFile } from 'node:child_process';
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
  accessToken, authenticated, cookieCredential, cookieName, helperCredential, keyCredential, proofFor, proveListener, sameSecret,
  sessionCookie, verifiedBearer,
} from './auth.ts';
import { startServer } from './server.ts';
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

  it('a garbage file is replaced', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'token'), 'nope', { mode: 0o600 });
    expect(accessToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a file readable by group or other is taken as leaked and rotated', () => {
    const t = accessToken();
    fs.chmodSync(path.join(home, 'token'), 0o644);
    const fresh = accessToken();
    expect(fresh).not.toBe(t);
    expect(fs.statSync(path.join(home, 'token')).mode & 0o777).toBe(0o600);
    fs.chmodSync(path.join(home, 'token'), 0o640);
    expect(accessToken()).not.toBe(fresh);
  });

  it('a file of another user is refused, not used and not replaced', () => {
    const t = accessToken();
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid!() + 1) as never);
    expect(() => accessToken()).toThrow(/belongs to another user/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(path.join(home, 'token'), 'utf8')).toBe(t);
  });

  it.skipIf(process.getuid?.() === 0)('a file that cannot be read throws; it never rotates', () => {
    const t = accessToken();
    fs.chmodSync(path.join(home, 'token'), 0o000);
    expect(() => accessToken()).toThrow(/cannot read/);
    fs.chmodSync(path.join(home, 'token'), 0o600);
    expect(accessToken()).toBe(t);
  });

  it('a directory in its place throws too', () => {
    fs.mkdirSync(path.join(home, 'token'), { recursive: true });
    expect(() => accessToken()).toThrow();
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
    const all = [cookieCredential, keyCredential, helperCredential].map((f) => f(token, 4777, N1));
    expect(new Set(all).size).toBe(3);
    for (const f of [cookieCredential, keyCredential, helperCredential]) {
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

  it('authenticated: the cookie reads; writing needs the key too; a Bearer (helper or raw token) does both', () => {
    const cookie = `nb_4777=${cookieCredential(token, 4777, N1)}`;
    const key = keyCredential(token, 4777, N1);
    const ok = (h: http.IncomingHttpHeaders, write: boolean) => authenticated(h, token, 4777, N1, write);
    expect(ok({ cookie }, false)).toBe(true);
    expect(ok({ cookie }, true)).toBe(false);
    expect(ok({ cookie, 'x-nota-bene-key': key }, true)).toBe(true);
    expect(ok({ cookie, 'sec-websocket-protocol': `nb.${key}` }, true)).toBe(true);
    expect(ok({ cookie, 'sec-websocket-protocol': `other, nb.${key}` }, true)).toBe(true);
    expect(ok({ 'x-nota-bene-key': key }, false)).toBe(false); // the key alone opens nothing
    expect(ok({ cookie, 'x-nota-bene-key': 'f'.repeat(64) }, true)).toBe(false);
    expect(ok({ cookie, 'x-nota-bene-key': keyCredential(token, 4778, N1) }, true)).toBe(false);
    expect(ok({ cookie, 'x-nota-bene-key': keyCredential(token, 4777, N2) }, true)).toBe(false);
    for (const write of [false, true]) {
      expect(ok({ authorization: `Bearer ${helperCredential(token, 4777, N1)}` }, write)).toBe(true);
      expect(ok({ authorization: `Bearer ${token}` }, write)).toBe(true);
      expect(ok({ authorization: `Bearer ${helperCredential(token, 4777, N2)}` }, write)).toBe(false);
      expect(ok({ authorization: `Bearer ${helperCredential(token, 4778, N1)}` }, write)).toBe(false);
      expect(ok({ authorization: `Bearer ${cookieCredential(token, 4777, N1)}` }, write)).toBe(false); // the cookie's value is not a bearer
      expect(ok({ cookie: `nb_4777=${cookieCredential(token, 4777, N2)}`, 'x-nota-bene-key': key }, write)).toBe(false);
      expect(ok({ cookie: `nb_4778=${cookieCredential(token, 4778, N1)}`, 'x-nota-bene-key': key }, write)).toBe(false);
      expect(ok({}, write)).toBe(false);
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
    const ws = new WebSocket(url.replace('http', 'ws'), protocols ?? [], { headers });
    closers.push(async () => { ws.terminate(); });
    ws.once('message', (d) => resolve({ ws, frame: String(d) }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode! }));
    ws.once('error', (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}
/** the page: the cookie, and the key as the subprotocol */
const pageSocket = (s: Booted, key = s.key, cookie = s.cookie) => wsTry(s.url, { cookie, origin: s.origin }, [`nb.${key}`]);

describe('the read tier: the cookie alone opens GET routes', () => {
  const GETS = ['/info', '/tree?path=', '/file?path=a.txt', '/complete?q=a', '/sources', '/sessions', '/history?session=x&before=1',
    '/subagent?session=x&tool=y', '/task-output?session=x&task=y', '/attach/' + 'a'.repeat(64), '/system/about', '/system/windows', '/git-status'];

  it('no auth, a wrong credential, and another port\'s or launch\'s are refused with 401', async () => {
    const s = await boot({ nonce: N1 });
    for (const p of GETS) {
      expect(await req(s.port, p).then((r) => r.status), p).toBe(401);
      expect((await req(s.port, p, { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { authorization: `Bearer ${helperCredential(s.token, s.port, N2)}` } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { cookie: `${cookieName(s.port)}=${cookieCredential(s.token, s.port, N2)}` } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { cookie: `${cookieName(s.port + 1)}=${cookieCredential(s.token, s.port + 1, N1)}` } })).status, p).toBe(401);
    }
  });

  it('the cookie reads project files, with Range (video, audio); the helper bearer and the raw token do too', async () => {
    const s = await boot({ nonce: N1 });
    expect((await req(s.port, '/file?path=a.txt', { headers: { cookie: s.cookie } })).body).toBe('project file');
    expect((await req(s.port, '/file?path=a.txt', { headers: { cookie: s.cookie, range: 'bytes=0-6' } })).status).toBe(206);
    expect((await req(s.port, '/file?path=a.txt', { method: 'HEAD', headers: { cookie: s.cookie } })).status).toBe(200);
    expect((await req(s.port, '/info', { headers: { authorization: `Bearer ${s.helper}` } })).status).toBe(200);
    expect((await req(s.port, '/info', { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(200);
    expect((await req(s.port, '/file?path=a.txt', { headers: { range: 'bytes=0-6' } })).status).toBe(401);
  });

  it('the app shell and its assets are public; the Host check still comes first', async () => {
    const s = await boot({ nonce: N1 });
    expect((await req(s.port, '/')).body).toContain('shell');
    expect((await req(s.port, '/app.js')).status).toBe(200);
    expect((await req(s.port, '/some/deep/link')).body).toContain('shell');
    expect((await req(s.port, '/info', { headers: { host: 'evil.example:1', authorization: `Bearer ${s.helper}` } })).status).toBe(403);
  });
});

describe('the write tier: the cookie is not enough', () => {
  it('POST/PUT/DELETE with the cookie alone are 401, also with a forged allowed Origin; cookie + key passes', async () => {
    const s = await boot({ nonce: N1 });
    for (const [method, p] of [['POST', '/restart-server'], ['POST', '/attach'], ['POST', '/marks/x/y'], ['DELETE', '/marks/x'], ['POST', '/system/prefs'], ['POST', '/system/storage/clean']] as const) {
      const h = { cookie: s.cookie, origin: s.origin, 'content-type': 'application/json' };
      expect((await req(s.port, p, { method, headers: h, body: '{}' })).status, `${method} ${p}`).toBe(401);
      expect((await req(s.port, p, { method, headers: { ...h, 'x-nota-bene-key': 'f'.repeat(64) }, body: '{}' })).status, `${method} ${p} wrong key`).toBe(401);
    }
    // with the key the request is the page's own: it reaches the route (restart-server says "not supervised")
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: { cookie: s.cookie, origin: s.origin, 'x-nota-bene-key': s.key } })).status).toBe(409);
    // a bearer needs no key
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: { authorization: `Bearer ${s.helper}`, origin: s.origin } })).status).toBe(409);
  });

  it('the key of another port or another launch does not open the write tier', async () => {
    const s = await boot({ nonce: N1 });
    for (const key of [keyCredential(s.token, s.port + 1, N1), keyCredential(s.token, s.port, N2), s.cookie.split('=')[1]!, s.helper]) {
      const r = await req(s.port, '/restart-server', { method: 'POST', headers: { cookie: s.cookie, origin: s.origin, 'x-nota-bene-key': key } });
      expect(r.status).toBe(401);
    }
  });
});

describe('/auth', () => {
  const login = (s: Booted, token: string, headers: Record<string, string> = {}) =>
    req(s.port, '/auth', { method: 'POST', headers: { origin: s.origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token }) });

  it('the right token sets the cookie and returns the key; together they open the socket', async () => {
    const s = await boot({ nonce: N1 });
    const r = await login(s, s.token);
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

  it('a wrong token, a derived value in its place, and a bad body get 401 or 400 and no cookie', async () => {
    const s = await boot({ nonce: N1 });
    for (const t of ['f'.repeat(64), s.key, s.helper, '', 'x']) {
      const r = await login(s, t);
      expect(r.status).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect((await req(s.port, '/auth', { method: 'POST', headers: { origin: s.origin }, body: 'not json' })).status).toBe(400);
  });

  it('is a same-origin POST only: no Origin and a foreign Origin are refused even with the right token', async () => {
    const s = await boot({ nonce: N1 });
    const none = await req(s.port, '/auth', { method: 'POST', body: JSON.stringify({ token: s.token }) });
    expect(none.status).toBe(403);
    expect(none.headers['set-cookie']).toBeUndefined();
    expect((await login(s, s.token, { origin: 'https://evil.example' })).status).toBe(403);
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
        const ws = new WebSocket(s.url.replace('http', 'ws'), { headers });
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
      expect((await req(port, p, { headers: { cookie } })).status, p).toBe(401);
      expect((await req(port, p, { headers: { authorization: `Bearer ${helper}` } })).status, p).toBe(401);
    }
    expect((await wsTry(later.url, { cookie, origin: later.origin }, [`nb.${key}`])).status).toBe(401);
    expect((await wsTry(later.url, { authorization: `Bearer ${helper}` })).status).toBe(401);
    // the later launch's own values work
    expect((await req(port, '/info', { headers: { cookie: later.cookie } })).status).toBe(200);
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
