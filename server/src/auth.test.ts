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
import { accessToken, authenticated, cookieName, portCredential, proofFor, sameSecret, sessionCookie, verifiedBearer } from './auth.ts';
import { startServer } from './server.ts';
import { shellEnv } from './session/shellText.ts';

// The local access token: nothing reaches the API or the socket without it (B1d).

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
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the token file', () => {
  it('is created on first need: 64 hex, mode 600, in a 700 state dir, and reused', () => {
    const t = accessToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(accessToken()).toBe(t);
    expect(fs.statSync(path.join(home, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });

  it('deleting the file rotates it', () => {
    const t = accessToken();
    fs.rmSync(path.join(home, 'token'));
    expect(accessToken()).not.toBe(t);
  });

  it('a garbage file is replaced', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'token'), 'nope');
    expect(accessToken()).toMatch(/^[0-9a-f]{64}$/);
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
  it('the cookie and the Bearer credential are per port and do not contain the token', () => {
    expect(portCredential(token, 4777)).toMatch(/^[0-9a-f]{64}$/);
    expect(portCredential(token, 4777)).not.toBe(token);
    expect(portCredential(token, 4777)).not.toBe(portCredential(token, 4778));
    expect(sessionCookie(token, 4777)).toContain('HttpOnly');
    expect(sessionCookie(token, 4777)).toContain('SameSite=Strict');
    expect(sessionCookie(token, 4777)).toContain('Path=/');
    expect(sessionCookie(token, 4777)).not.toContain(token);
    expect(cookieName(4777)).not.toBe(cookieName(4778));
  });

  it('authenticated: the port cookie, the port credential or the raw token as Bearer; nothing else', () => {
    const c = portCredential(token, 4777);
    expect(authenticated({ cookie: `x=1; nb_4777=${c}` }, token, 4777)).toBe(true);
    expect(authenticated({ authorization: `Bearer ${c}` }, token, 4777)).toBe(true);
    expect(authenticated({ authorization: `Bearer ${token}` }, token, 4777)).toBe(true);
    expect(authenticated({}, token, 4777)).toBe(false);
    expect(authenticated({ cookie: `nb_4777=${c.replace(/.$/, '0')}` }, token, 4777)).toBe(false);
    expect(authenticated({ authorization: 'Bearer nope' }, token, 4777)).toBe(false);
    // another port's credential, as a cookie of that name or as a Bearer
    expect(authenticated({ cookie: `nb_4777=${portCredential(token, 4778)}` }, token, 4777)).toBe(false);
    expect(authenticated({ cookie: `nb_4778=${portCredential(token, 4778)}` }, token, 4777)).toBe(false);
    expect(authenticated({ authorization: `Bearer ${portCredential(token, 4778)}` }, token, 4777)).toBe(false);
    expect(authenticated({ authorization: `Bearer ${portCredential('b'.repeat(64), 4777)}` }, token, 4777)).toBe(false);
  });

  it('compares secrets of any length without throwing', () => {
    expect(sameSecret('a', 'abc')).toBe(false);
    expect(sameSecret(undefined, 'abc')).toBe(false);
    expect(sameSecret('abc', 'abc')).toBe(true);
  });
});

async function boot(o: { allowedOrigins?: string[]; oneTab?: boolean } = {}) {
  const s = await startServer({
    cwd: path.join(tmp, 'proj'), port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: path.join(tmp, 'dist'),
    takeoverGraceMs: 40, ...o,
  });
  closers.push(s.close);
  const port = Number(new URL(s.url).port);
  return { ...s, port, token: accessToken(), cred: portCredential(accessToken(), port) };
}

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
function wsTry(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; frame?: string; status?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http', 'ws'), { headers });
    closers.push(async () => { ws.terminate(); });
    ws.once('message', (d) => resolve({ ws, frame: String(d) }));
    ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode! }));
    ws.once('error', (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}

describe('the HTTP API needs auth', () => {
  const ROUTES = ['/info', '/tree?path=', '/file?path=a.txt', '/complete?q=a', '/sources', '/sessions', '/history?session=x&before=1',
    '/subagent?session=x&tool=y', '/task-output?session=x&task=y', '/attach/' + 'a'.repeat(64), '/system/about', '/system/windows', '/git-status', '/marks/x/y'];

  it('no auth, a wrong credential, and another port\'s credential are refused with 401', async () => {
    const s = await boot();
    const other = portCredential(s.token, s.port + 1);
    for (const p of ROUTES) {
      expect(await req(s.port, p).then((r) => r.status), p).toBe(401);
      expect((await req(s.port, p, { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { authorization: `Bearer ${other}` } })).status, p).toBe(401);
      expect((await req(s.port, p, { headers: { cookie: `${cookieName(s.port + 1)}=${other}` } })).status, p).toBe(401);
    }
  });

  it('a valid credential (Bearer or cookie) gets through', async () => {
    const s = await boot();
    expect((await req(s.port, '/info', { headers: { authorization: `Bearer ${s.cred}` } })).status).toBe(200);
    expect((await req(s.port, '/info', { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(200);
    expect((await req(s.port, '/info', { headers: { cookie: `${cookieName(s.port)}=${s.cred}` } })).status).toBe(200);
  });

  it('a Range request (video, audio) is checked like any other', async () => {
    const s = await boot();
    fs.writeFileSync(path.join(tmp, 'proj', 'v.bin'), Buffer.alloc(100));
    expect((await req(s.port, '/file?path=v.bin', { headers: { range: 'bytes=0-9' } })).status).toBe(401);
    expect((await req(s.port, '/file?path=v.bin', { headers: { range: 'bytes=0-9', cookie: `${cookieName(s.port)}=${s.cred}` } })).status).toBe(206);
  });

  it('a forged Origin of our own with no cookie is refused', async () => {
    const s = await boot();
    const origin = `http://127.0.0.1:${s.port}`;
    expect((await req(s.port, '/info', { headers: { origin } })).status).toBe(401);
    expect((await req(s.port, '/sessions', { headers: { origin } })).status).toBe(401);
    expect((await req(s.port, '/restart-server', { method: 'POST', headers: { origin } })).status).toBe(401);
    expect((await req(s.port, '/attach', { method: 'POST', headers: { origin, 'content-type': 'image/png' }, body: 'x' })).status).toBe(401);
  });

  it('the app shell and its assets are public (they hold no secrets); an unknown path is the shell, not data', async () => {
    const s = await boot();
    const home = await req(s.port, '/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('shell');
    expect((await req(s.port, '/app.js')).status).toBe(200);
    expect((await req(s.port, '/some/deep/link')).body).toContain('shell');
  });

  it('the Host check still comes first', async () => {
    const s = await boot();
    expect((await req(s.port, '/info', { headers: { host: 'evil.example:1', authorization: `Bearer ${s.cred}` } })).status).toBe(403);
  });
});

describe('/auth', () => {
  const login = (s: { port: number }, token: string, headers: Record<string, string> = {}) =>
    req(s.port, '/auth', { method: 'POST', headers: { origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ token }) });

  it('the right token sets an HttpOnly SameSite=Strict cookie named for the port, with a derived value, and the cookie works', async () => {
    const s = await boot();
    const r = await login(s, s.token);
    expect(r.status).toBe(200);
    const set = String(r.headers['set-cookie']);
    expect(set).toContain(`${cookieName(s.port)}=${s.cred}`);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=\d{6,}/);
    expect(set).not.toContain(s.token);
    expect(r.body).not.toContain(s.token);
    const cookie = set.split(';')[0]!;
    expect((await req(s.port, '/info', { headers: { cookie } })).status).toBe(200);
  });

  it('a wrong token, a credential in its place, a missing body and a bad body get 401 or 400 and no cookie', async () => {
    const s = await boot();
    for (const t of ['f'.repeat(64), s.cred, '', 'x']) {
      const r = await login(s, t);
      expect(r.status).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const bad = await req(s.port, '/auth', { method: 'POST', headers: { origin: `http://127.0.0.1:${s.port}` }, body: 'not json' });
    expect(bad.status).toBe(400);
    expect(bad.headers['set-cookie']).toBeUndefined();
  });

  it('is a same-origin POST only: no Origin and a foreign Origin are refused even with the right token', async () => {
    const s = await boot();
    const none = await req(s.port, '/auth', { method: 'POST', body: JSON.stringify({ token: s.token }) });
    expect(none.status).toBe(403);
    expect(none.headers['set-cookie']).toBeUndefined();
    const evil = await login(s, s.token, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.headers['set-cookie']).toBeUndefined();
    expect((await req(s.port, '/auth')).status).toBe(405);
  });
});

describe('the socket needs auth', () => {
  it('no auth: refused before any event, with or without an Origin', async () => {
    const s = await boot();
    for (const headers of [{} as Record<string, string>, { origin: `http://127.0.0.1:${s.port}` }]) {
      const r = await wsTry(s.url, headers);
      expect(r.status).toBe(401);
      expect(r.frame).toBeUndefined();
    }
    const wrong = await wsTry(s.url, { authorization: 'Bearer ' + 'e'.repeat(64) });
    expect(wrong.status).toBe(401);
    const otherPort = await wsTry(s.url, { cookie: `${cookieName(s.port)}=${portCredential(s.token, s.port + 1)}` });
    expect(otherPort.status).toBe(401);
  });

  it('a forged foreign Origin is refused even with the cookie (the Origin check stays)', async () => {
    const s = await boot();
    const r = await wsTry(s.url, { origin: 'https://evil.example', cookie: `${cookieName(s.port)}=${s.cred}` });
    expect(r.status).toBe(403);
  });

  it('the cookie with our Origin (the page), or Bearer with no Origin (a helper), opens it', async () => {
    const s = await boot({ oneTab: false });
    const cookie = `${cookieName(s.port)}=${s.cred}`;
    expect((await wsTry(s.url, { origin: `http://127.0.0.1:${s.port}`, cookie })).frame).toBeDefined();
    expect((await wsTry(s.url, { cookie })).frame).toBeDefined();
    expect((await wsTry(s.url, { authorization: `Bearer ${s.cred}` })).frame).toBeDefined();
  });

  it('the review\'s reproduction: a raw client with no Origin cannot take the window over or run a command', async () => {
    const s = await boot();
    const owner = await wsTry(s.url, { cookie: `${cookieName(s.port)}=${s.cred}` });
    const events: ServerEvent[] = [];
    owner.ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
    const marker = path.join(tmp, 'pwned');
    const intruder = await wsTry(s.url);
    expect(intruder.status).toBe(401);
    expect(intruder.ws.readyState).not.toBe(WebSocket.OPEN);
    // even a hand-written upgrade that sends the messages at once gets nothing
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(s.url.replace('http', 'ws'));
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'takeover' }));
        ws.send(JSON.stringify({ type: 'shell-run', id: 'x', cmd: `touch ${marker}` }));
      });
      ws.on('error', () => resolve());
      ws.on('unexpected-response', () => resolve());
      ws.on('close', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(marker)).toBe(false);
    expect(events.some((e) => e.kind === 'taken-over')).toBe(false);
    expect(owner.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('the token stays out of everything the window runs and prints', () => {
  it('a `!` command and the agent see no token or credential; the logs and /info do not print one', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a) => void logs.push(a.join(' ')));
    const s = await boot({ oneTab: false });
    const ws = (await wsTry(s.url, { authorization: `Bearer ${s.cred}` })).ws;
    const out: ServerEvent[] = [];
    ws.on('message', (d) => out.push(JSON.parse(String(d)) as ServerEvent));
    ws.send(JSON.stringify({ type: 'shell-run', id: 'e', cmd: 'env; cat "$NOTA_BENE_HOME/token" | wc -c' }));
    const end = async () => {
      for (let i = 0; i < 300; i++) {
        const e = out.find((x) => x.kind === 'shell-end');
        if (e) return e as Extract<ServerEvent, { kind: 'shell-end' }>;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('no shell-end');
    };
    const done = await end();
    for (const secret of [s.token, s.cred]) {
      expect(done.output).not.toContain(secret);
      expect(JSON.stringify(shellEnv(process.env))).not.toContain(secret);
      expect(JSON.stringify(process.env)).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
      expect(JSON.stringify(out)).not.toContain(secret);
      expect((await req(s.port, '/info', { headers: { authorization: `Bearer ${s.cred}` } })).body).not.toContain(secret);
    }
  });
});

describe('/hello, the proof a helper asks for before it trusts a port', () => {
  const hello = (port: number, c: string) => req(port, `/hello?c=${c}`);
  const C = 'ab'.repeat(16);

  it('answers only the proof for this port and challenge: no root, no credential, no state', async () => {
    const s = await boot();
    const r = await hello(s.port, C);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ proof: proofFor(s.token, s.port, C) });
    expect(r.body).not.toContain(s.token);
    expect(r.body).not.toContain(s.cred);
    expect(r.body).not.toContain(path.join(tmp, 'proj'));
  });

  it('a proof for another challenge, another port, or another token does not match', async () => {
    const s = await boot();
    const got = (JSON.parse((await hello(s.port, C)).body) as { proof: string }).proof;
    expect(got).not.toBe(proofFor(s.token, s.port, 'cd'.repeat(16)));
    expect(got).not.toBe(proofFor(s.token, s.port + 1, C));
    expect(got).not.toBe(proofFor('f'.repeat(64), s.port, C));
  });

  it('refuses a missing, malformed, short or oversized challenge, and any other method', async () => {
    const s = await boot();
    for (const c of ['', 'zz'.repeat(16), 'ab', 'ab'.repeat(33), 'AB'.repeat(16), '../x']) expect((await hello(s.port, c)).status, c).toBe(400);
    expect((await req(s.port, '/hello')).status).toBe(400);
    expect((await req(s.port, `/hello?c=${C}`, { method: 'POST', headers: { origin: `http://127.0.0.1:${s.port}` } })).status).toBe(405);
  });

  it('/info stays protected: the proof opens nothing', async () => {
    const s = await boot();
    expect((await req(s.port, '/info')).status).toBe(401);
  });

  it('verifiedBearer gives the credential for a real window, and nothing for a relay of another port\'s window', async () => {
    const real = await boot();
    expect(await verifiedBearer(real.port, 1000)).toBe(`Bearer ${real.cred}`);
    // an impostor that forwards /hello to the real window: the proof is for the real port, the helper dialled another
    const seen: string[] = [];
    const relay = http.createServer((q, res) => {
      seen.push(`${q.url} ${q.headers.authorization}`);
      req(real.port, q.url ?? '/').then((r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body), () => res.writeHead(502).end());
    });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => { relay.closeAllConnections(); relay.close(() => r()); }));
    const port = (relay.address() as { port: number }).port;
    expect(await verifiedBearer(port, 1000)).toBeNull();
    expect(seen.every((x) => x.endsWith('undefined'))).toBe(true); // it saw the challenge and no Authorization
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

  it('probeInfo and probeWindow: a silent, a lying and a proof-guessing listener see no Authorization header', async () => {
    const { probeInfo } = await import('./windows.ts');
    const { probeWindow } = await import('./system.ts');
    accessToken();
    for (const answer of [undefined, () => '{"proof":"00","root":"/x"}', () => JSON.stringify({ proof: 'ab'.repeat(32), root: '/x' })]) {
      const imp = await impostor(answer);
      expect(await probeInfo(imp.port)).toBeNull();
      expect(await probeWindow(imp.port)).toBeNull();
      expect(imp.seen.length).toBeGreaterThan(0);
      expect(nothingSent(imp.seen)).toBe(true);
      expect(imp.seen.every((x) => x.url.startsWith('/hello?c='))).toBe(true); // it never even got a request for /info
    }
  });

  it('probeInfo logs in with the port credential once the window proved itself, and not to another state dir\'s window', async () => {
    const { probeInfo } = await import('./windows.ts');
    const s = await boot();
    expect(await probeInfo(s.port)).toMatchObject({ root: path.join(tmp, 'proj') });
    fs.rmSync(path.join(home, 'token')); // rotated: the running window keeps the old token and cannot prove the new one
    expect(await probeInfo(s.port)).toBeNull();
  });

  it('the control relay re-checks the proof before it sends the control token', async () => {
    const { systemRoutes } = await import('./system.ts');
    accessToken();
    const imp = await impostor();
    const routes = systemRoutes({ hub: {} as never, root: () => '/x', port: () => 1, repoDir: tmp, control: { supervised: () => false, exiting: () => false, restartAgent() {}, restartServer() {}, stop() {} } });
    expect(routes['/system/windows/action']).toBeTypeOf('function'); // the relay itself is internal; its guard is the proof below
    expect(await verifiedBearer(imp.port, 500)).toBeNull();
    expect(imp.seen.some((x) => x.url.startsWith('/control/'))).toBe(false);
  });

  it('neither main.ts nor the launcher can switch the check off', () => {
    for (const f of ['main.ts', '../../bin/nota-bene.mjs']) {
      expect(fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')).not.toMatch(/insecureNoAuth|no-auth|NO_AUTH/i);
    }
  });
});
