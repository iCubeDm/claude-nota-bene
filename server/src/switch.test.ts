import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import type { FakeTurn } from './agent/fake.ts';
import { CommentStore } from './comments.ts';
import { startServer } from './server.ts';
import { lastSession } from './state.ts';

const SA = '11111111-1111-4111-8111-111111111111';
const SB = '22222222-2222-4222-8222-222222222222';
const SX = '33333333-3333-4333-8333-333333333333';

let tmp: string;
let home: string;
let dist: string;
let A: string;
let B: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-switch-')));
  home = path.join(tmp, 'home');
  dist = path.join(tmp, 'dist');
  A = path.join(tmp, 'a');
  B = path.join(tmp, 'b');
  for (const d of [home, dist, A, B]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  fs.writeFileSync(path.join(A, 'a-only.txt'), 'a');
  fs.writeFileSync(path.join(B, 'b-only.txt'), 'b');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function backendFor(turns: FakeTurn[] = [{ text: 'hello' }]) {
  return fakeBackend(turns, {
    sessions: [
      { id: SA, cwd: A, summary: 'A work', lastModified: 1, fileSize: 10, history: [{ role: 'user', text: 'a-before' }] },
      { id: SB, cwd: B, customTitle: 'B work', lastModified: 2, fileSize: 20, history: [{ role: 'user', text: 'b-before' }, { role: 'assistant', text: 'b-reply' }] },
      { id: SX, cwd: '', summary: 'nowhere', lastModified: 3, fileSize: 30 },
    ],
  });
}

async function boot(o: { backend?: ReturnType<typeof fakeBackend>; resume?: string } = {}) {
  const backend = o.backend ?? backendFor();
  const s = await startServer({ insecureNoAuth: true, cwd: A, port: 0, backend, webDist: dist, oneTab: false, ...(o.resume ? { resume: o.resume } : {}) });
  closers.push(s.close);
  return { ...s, backend };
}

type Client = { ws: WebSocket; events: ServerEvent[] };
async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url.replace('http', 'ws'));
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const get = (url: string, p: string) => fetch(url + p);
const isResult = (e: ServerEvent) => e.kind === 'agent' && e.e.t === 'turn-end';
const lastOf = <K extends ServerEvent['kind']>(c: Client, kind: K) =>
  c.events.filter((e): e is Extract<ServerEvent, { kind: K }> => e.kind === kind).at(-1);
const errors = (c: Client) => c.events.filter((e): e is Extract<ServerEvent, { kind: 'server-error' }> => e.kind === 'server-error');
const switched = (c: Client, id: string | null) => lastOf(c, 'session')?.id === id && lastOf(c, 'comments') !== undefined
  && c.events.findLastIndex((e) => e.kind === 'comments') > c.events.findLastIndex((e) => e.kind === 'session');

/** After `mark`: a replay, then session(id), then comments, all received by this client (not merely server-side state). */
function switchedSince(c: Client, mark: number, id: string | null): boolean {
  const ev = c.events.slice(mark);
  const r = ev.findIndex((e) => e.kind === 'replay');
  if (r < 0) return false;
  const se = ev.findIndex((e, i) => i > r && e.kind === 'session' && e.id === id);
  return se > r && ev.some((e, i) => i > se && e.kind === 'comments');
}

const comment = (id: string): Comment => ({
  id, text: `t-${id}`, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id: 'm1' }, quote: 'q', prefix: '', suffix: '', start: 0, end: 1 },
});

describe('GET /sessions', () => {
  it('lists the sessions with a cwd, with titles, the current id and the root', async () => {
    const s = await boot({ resume: SA });
    const r = await get(s.url, '/sessions');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      current: SA,
      root: A,
      sessions: [
        { id: SA, title: 'A work', at: 1, size: 10, cwd: A },
        { id: SB, title: 'B work', at: 2, size: 20, cwd: B },
      ],
    });
  });

  it('refuses a foreign host', async () => {
    const s = await boot();
    const status = await new Promise<number>((resolve, reject) => {
      http.request({ host: '127.0.0.1', port: Number(new URL(s.url).port), path: '/sessions', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    expect(status).toBe(403);
  });
});

describe('switch', () => {
  it('moves to another dir: the replay resets, the new session arrives, and every route follows the new root', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    expect((await get(s.url, '/file?path=a-only.txt')).status).toBe(200);
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => switched(c, SB));

    const after = c.events.slice(mark).filter((e) => e.kind !== 'server-error');
    expect(after.map((e) => e.kind)).toEqual(['replay', 'replay', 'resumed', 'session', 'mode', 'model', 'idle-compact', 'stats', 'comments']);
    expect(after[0]).toEqual({ kind: 'replay', events: [] });
    const replay = after[1] as Extract<ServerEvent, { kind: 'replay' }>;
    expect(replay.events.map((e) => (e.kind === 'user' ? e.text : e.kind === 'agent' ? e.e.t : e.kind))).toEqual(['b-before', 'message']);
    expect(after[2]).toEqual({ kind: 'resumed', id: SB });
    expect(after[3]).toEqual({ kind: 'session', id: SB, root: B, title: 'B work', model: null });
    expect(errors(c)).toEqual([]);

    expect((await get(s.url, '/file?path=a-only.txt')).status).toBe(404);
    expect((await get(s.url, '/file?path=b-only.txt')).status).toBe(200);
    expect(await (await get(s.url, '/tree')).json()).toEqual([{ name: 'b-only.txt', dir: false }]);
    expect(await (await get(s.url, '/complete?q=only')).json()).toEqual(['b-only.txt']);
    expect(await (await get(s.url, '/info')).json()).toMatchObject({ root: B, session: SB });
    expect(lastSession(B)).toBe(SB);

    // a late socket gets the new session's history, not the old one's
    const late = await connect(s.url);
    await until(() => late.events.length > 0);
    const first = late.events[0] as Extract<ServerEvent, { kind: 'replay' }>;
    expect(JSON.stringify(first.events)).toContain('b-before');
    expect(JSON.stringify(first.events)).not.toContain('a-before');
  });

  it('every connected socket gets the reset', async () => {
    const s = await boot({ resume: SA });
    const c1 = await connect(s.url);
    const c2 = await connect(s.url);
    await until(() => lastOf(c1, 'comments') !== undefined && lastOf(c2, 'comments') !== undefined);
    c1.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    for (const c of [c1, c2]) {
      await until(() => switched(c, SB));
      expect(c.events.filter((e) => e.kind === 'replay').slice(1)[0]).toEqual({ kind: 'replay', events: [] });
    }
  });

  it('a new session in a dir starts fresh there, in the mode saved for that dir', async () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ modes: { [B]: 'plan' } }));
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    c.ws.send(JSON.stringify({ type: 'switch', id: null, dir: B }));
    await until(() => switched(c, null) && lastOf(c, 'session')?.root === B);
    expect(lastOf(c, 'session')).toEqual({ kind: 'session', id: null, root: B, title: null, model: null });
    expect(lastOf(c, 'mode')).toEqual({ kind: 'mode', mode: 'plan' });
    expect(s.backend.starts.at(-1)).toEqual({ cwd: B, permissionMode: 'plan' });
    expect(c.events.some((e) => e.kind === 'resumed' && e.id === null)).toBe(false);
  });

  it('is rejected while the agent is busy', async () => {
    const s = await boot({ backend: backendFor([{ text: 'x'.repeat(100), chunk: 1, delayMs: 10 }]) });
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'long' }));
    await until(() => c.events.some((e) => e.kind === 'agent'));
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => errors(c).length > 0);
    expect(errors(c)[0]).toMatchObject({ where: 'switch' });
    expect(await (await get(s.url, '/info')).json()).toMatchObject({ root: A });
    expect(s.backend.starts).toHaveLength(1);
  });

  it('two switches at once: exactly one runs, the other is rejected (as a switch error)', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    c.ws.send(JSON.stringify({ type: 'switch', id: SA, dir: A }));
    await until(() => switched(c, SB) && errors(c).length > 0);
    expect(errors(c)).toHaveLength(1);
    expect(errors(c)[0]).toMatchObject({ where: 'switch' });
    expect(s.backend.starts.map((x) => x.resume)).toEqual([SA, SB]);
  });

  it('refuses a dir that is not an existing directory, or that is not the session\'s own', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    const bad: [string | null, string][] = [
      [null, path.join(tmp, 'missing')],
      [null, path.join(A, 'a-only.txt')],
      [SB, A], // the session lives in B
      ['44444444-4444-4444-8444-444444444444', A], // unknown
    ];
    for (const [i, [id, dir]] of bad.entries()) {
      c.ws.send(JSON.stringify({ type: 'switch', id, dir }));
      await until(() => errors(c).length === i + 1);
    }
    expect(errors(c).map((e) => e.where)).toEqual(['switch', 'switch', 'switch', 'switch']);
    expect(s.backend.starts).toHaveLength(1);
    expect(await (await get(s.url, '/info')).json()).toMatchObject({ root: A, session: SA });
  });

  it('a pending permission of the old session is denied and never resurfaces', async () => {
    const s = await boot({ backend: backendFor([{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]) });
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    c.ws.send(JSON.stringify({ type: 'interrupt' }));
    await until(() => c.events.some(isResult));
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => switched(c, SB));
    const late = await connect(s.url);
    await until(() => late.events.length > 0);
    expect(JSON.stringify(late.events[0])).not.toContain('"permission"');
  });
});

describe('restart', () => {
  it('resumes the same id in the same dir', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await until(() => s.backend.starts.length === 2 && switchedSince(c, mark, SA));
    expect(s.backend.starts[1]).toMatchObject({ cwd: A, resume: SA });
    expect(lastOf(c, 'session')).toMatchObject({ id: SA, root: A });
    expect(c.events.filter((e) => e.kind === 'replay').at(-1)!.events.length).toBeGreaterThan(0);
  });

  it('for a session that has no id yet, starts fresh in the same dir', async () => {
    const s = await boot();
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await until(() => s.backend.starts.length === 2 && switchedSince(c, mark, null));
    expect(s.backend.starts[1]).toEqual({ cwd: A, permissionMode: 'auto' });
  });

  it('a fake session id (the CLI\'s own, not uuid-shaped) is resumed too', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => c.events.some(isResult));
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await until(() => s.backend.starts.length === 2 && switchedSince(c, mark, 'fake-session'));
    expect(s.backend.starts[1]).toMatchObject({ resume: 'fake-session' });
  });
});

describe('restart while busy', () => {
  it('interrupts the stuck turn, ends busy and emits the new session; switch stays busy-gated', async () => {
    const s = await boot({ backend: backendFor([{ text: 'x'.repeat(2000), chunk: 1, delayMs: 10 }]) });
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'long' }));
    await until(() => lastOf(c, 'session')?.id === 'fake-session');
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => errors(c).length > 0);
    expect(errors(c)[0]).toMatchObject({ where: 'switch' });
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await until(() => s.backend.starts.length === 2 && switchedSince(c, mark, 'fake-session'));
    const after = c.events.slice(mark);
    expect(after.some((e) => e.kind === 'replay')).toBe(true);
    expect(after.find((e) => e.kind === 'session')).toMatchObject({ id: 'fake-session', root: A });
    expect(s.backend.starts[1]).toMatchObject({ resume: 'fake-session' });
    expect(errors(c)).toHaveLength(1);
    // not busy any more: a switch now runs
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => switched(c, SB));
    expect(errors(c)).toHaveLength(1);
  });
});

describe('fix round 1', () => {
  it('a new session may only open here or where a session lives: / is refused and the root stays', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    c.ws.send(JSON.stringify({ type: 'switch', id: null, dir: '/' }));
    await until(() => errors(c).length === 1);
    expect(errors(c)[0]).toMatchObject({ where: 'switch' });
    c.ws.send(JSON.stringify({ type: 'switch', id: null, dir: tmp })); // an existing dir no session lives in
    await until(() => errors(c).length === 2);
    expect(errors(c)[1]).toMatchObject({ where: 'switch' });
    expect(s.backend.starts).toHaveLength(1);
    expect(await (await get(s.url, '/info')).json()).toMatchObject({ root: A, session: SA });
    expect((await get(s.url, '/file?path=a-only.txt')).status).toBe(200);
    // here is always fine
    c.ws.send(JSON.stringify({ type: 'switch', id: null, dir: A }));
    await until(() => switched(c, null));
    expect(errors(c)).toHaveLength(2);
  });

  it('a restart before the first init keeps the unsent comments', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [comment('c1')] }));
    await until(() => lastOf(c, 'comments')?.items.length === 1);
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await until(() => s.backend.starts.length === 2 && switchedSince(c, mark, null));
    expect(lastOf(c, 'comments')!.items).toEqual([comment('c1')]);
    // and they still follow the session to its first id
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => c.events.some(isResult));
    expect(new CommentStore({ dir: path.join(home, 'comments') }).get('fake-session')).toEqual([comment('c1')]);
  });

  it('a restart with an open permission card denies it; the new session has no stuck permission', async () => {
    const s = await boot({ backend: backendFor([{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]) });
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'restart' }));
    await until(() => s.backend.starts.length === 2 && switchedSince(c, mark, 'fake-session'));
    expect(c.events.find((e) => e.kind === 'permission-done')).toMatchObject({ allow: false });
    const late = await connect(s.url);
    await until(() => late.events.length > 0);
    expect(JSON.stringify(late.events[0])).not.toContain('"permission"');
    // not busy: a switch runs
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => switched(c, SB));
    expect(errors(c)).toEqual([]);
  });

  it('a comments message during a switch is rejected as stale, even for the target id', async () => {
    const store = new CommentStore({ dir: path.join(home, 'comments') });
    store.set(SB, [comment('b1')]);
    const backend = backendFor();
    const history = backend.history;
    backend.history = async (...a) => { await new Promise((r) => setTimeout(r, 200)); return history(...a); };
    const s = await boot({ backend, resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => c.events.slice(mark).some((e) => e.kind === 'replay')); // torn down, history still loading
    c.ws.send(JSON.stringify({ type: 'comments', sessionId: SB, items: [comment('mid')] }));
    await until(() => errors(c).length > 0);
    expect(errors(c)[0]).toMatchObject({ where: 'comments', message: 'stale session' });
    await until(() => switched(c, SB));
    expect(store.get(SB)).toEqual([comment('b1')]);
  });

  it('a send during a switch gets send-refused on the asking socket only, never stored', async () => {
    const backend = backendFor();
    const history = backend.history;
    backend.history = async (...a) => { await new Promise((r) => setTimeout(r, 200)); return history(...a); };
    const s = await boot({ backend, resume: SA });
    const c = await connect(s.url);
    const other = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined && lastOf(other, 'comments') !== undefined);
    const mark = c.events.length;
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => c.events.slice(mark).some((e) => e.kind === 'replay')); // torn down, history still loading
    c.ws.send(JSON.stringify({ type: 'send', id: 'u9', text: 'too early' }));
    await until(() => c.events.some((e) => e.kind === 'send-refused'));
    expect(c.events.find((e) => e.kind === 'send-refused')).toEqual({ kind: 'send-refused', id: 'u9', reason: 'switching' });
    expect(errors(c)).toEqual([]);
    await until(() => switched(c, SB));
    expect(other.events.some((e) => e.kind === 'send-refused')).toBe(false);
    const late = await connect(s.url);
    await until(() => late.events.length > 0);
    expect(JSON.stringify(late.events[0])).not.toContain('send-refused');
  });

  it('a restart racing a switch: exactly one runs, the other is refused as a switch error', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    c.ws.send(JSON.stringify({ type: 'restart' }));
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => s.backend.starts.length === 2 && errors(c).length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.backend.starts).toHaveLength(2);
    expect(s.backend.starts[1]).toMatchObject({ resume: SA, cwd: A });
    expect(errors(c)).toEqual([expect.objectContaining({ where: 'switch' })]);
  });
});

describe('R14: comments for another session', () => {
  it('a push carrying the old session id after a switch is rejected and stores nothing', async () => {
    const store = new CommentStore({ dir: path.join(home, 'comments') });
    store.set(SB, [comment('b1')]);
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => switched(c, SB));
    expect(lastOf(c, 'comments')!.items).toEqual([comment('b1')]);
    const count = c.events.filter((e) => e.kind === 'comments').length;
    c.ws.send(JSON.stringify({ type: 'comments', sessionId: SA, items: [comment('stale')] }));
    await until(() => errors(c).length > 0);
    expect(errors(c)[0]).toMatchObject({ where: 'comments', message: 'stale session' });
    expect(store.get(SA)).toEqual([]);
    expect(store.get(SB)).toEqual([comment('b1')]);
    expect(c.events.filter((e) => e.kind === 'comments')).toHaveLength(count);
    // the current id is accepted
    c.ws.send(JSON.stringify({ type: 'comments', sessionId: SB, items: [comment('b1'), comment('b2')] }));
    await until(() => lastOf(c, 'comments')!.items.length === 2);
    expect(store.get(SB).map((x) => x.id)).toEqual(['b1', 'b2']);
  });

  it('a null session id is rejected once the session has an id', async () => {
    const s = await boot({ resume: SA });
    const c = await connect(s.url);
    await until(() => lastOf(c, 'comments') !== undefined);
    c.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [comment('x')] }));
    await until(() => errors(c).length > 0);
    expect(errors(c)[0]).toMatchObject({ where: 'comments', message: 'stale session' });
  });

  it('unsent comments of a new session do not follow the switch into another one', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [comment('n1')] }));
    await until(() => lastOf(c, 'comments')?.items.length === 1);
    c.ws.send(JSON.stringify({ type: 'switch', id: SB, dir: B }));
    await until(() => switched(c, SB));
    expect(lastOf(c, 'comments')!.items).toEqual([]);
    expect(new CommentStore({ dir: path.join(home, 'comments') }).get(SB)).toEqual([]);
  });
});

describe('title and model', () => {
  it('the session event carries the title after a result and the model from init', async () => {
    const backend = fakeBackend([{ text: 'hello', model: 'claude-fake' }], {
      sessions: [{ id: 'fake-session', cwd: A, summary: 'Hello chat', lastModified: 1, fileSize: 1 }],
    });
    const s = await boot({ backend });
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => lastOf(c, 'session')?.title === 'Hello chat');
    expect(lastOf(c, 'session')).toEqual({ kind: 'session', id: 'fake-session', root: A, title: 'Hello chat', model: 'claude-fake' });
    expect(await (await get(s.url, '/info')).json()).toMatchObject({ title: 'Hello chat', model: 'claude-fake' });
  });
});
