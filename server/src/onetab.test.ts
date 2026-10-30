import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-onetab-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-onetab-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(o: { grace?: number; heartbeat?: number; turns?: Parameters<typeof fakeBackend>[0] } = {}) {
  const s = await startServer({ insecureNoAuth: true,
    cwd: '/proj', port: 0, backend: fakeBackend(o.turns ?? [{ text: 'hello' }]), webDist: dist,
    takeoverGraceMs: o.grace ?? 60, ...(o.heartbeat ? { heartbeatMs: o.heartbeat } : {}),
  });
  closers.push(s.close);
  return s;
}

type Client = { ws: WebSocket; events: ServerEvent[]; closed: Promise<number> };
async function connect(url: string, o: { autoPong?: boolean } = {}): Promise<Client> {
  const ws = new WebSocket(url.replace('http', 'ws'), { autoPong: o.autoPong ?? true });
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events, closed };
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const kinds = (c: Client) => c.events.map((e) => e.kind);
const info = async (url: string) => (await fetch(`${url}/info`)).json() as Promise<{ clients: number; busy: boolean }>;

describe('one tab', () => {
  it('second socket gets occupied and no replay', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).toEqual(['occupied', 'hello']);
    expect(kinds(a)).toContain('replay');
  });

  it("occupied socket's send is ignored", async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    b.ws.send(JSON.stringify({ type: 'send', id: 'x1', text: 'from the occupied tab' }));
    b.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [] }));
    await new Promise((r) => setTimeout(r, 200));
    expect(a.events.some((e) => e.kind === 'user')).toBe(false);
    expect(kinds(b)).toEqual(['occupied', 'hello']);
  });

  it("occupied socket's restart and comments are ignored: no restart, comments unchanged", async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    const n = a.events.length;
    const c = { id: 'c1', anchor: { source: { kind: 'message', id: 'm1' }, start: 0, end: 1, quote: 'h', prefix: '', suffix: '' }, text: 'note', status: 'pending', createdAt: 1 };
    b.ws.send(JSON.stringify({ type: 'restart' }));
    b.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c] }));
    await new Promise((r) => setTimeout(r, 300));
    // a restart or a merged set would reach the owner as events (a restart resets the feed, a merge broadcasts the set)
    expect(a.events.slice(n)).toEqual([]);
    expect(kinds(b)).toEqual(['occupied', 'hello']);
    // control: the owner's own comments do arrive
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c] }));
    await until(() => a.events.slice(n).some((e) => e.kind === 'comments'));
  });

  it('two newcomers within one grace while the owner closes: one owner, one occupied', async () => {
    const s = await boot({ grace: 400 });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    const c = await connect(s.url);
    a.ws.close(1000);
    await until(() => kinds(b).includes('hello') && kinds(c).includes('hello'));
    const occupied = [b, c].filter((x) => kinds(x).includes('occupied'));
    const owners = [b, c].filter((x) => !kinds(x).includes('occupied'));
    expect(occupied).toHaveLength(1);
    expect(owners).toHaveLength(1);
    expect(kinds(owners[0]!)).toContain('replay');
    expect((await info(s.url)).clients).toBe(1);
  });

  it("a socket's messages during the grace are ignored", async () => {
    const s = await boot({ grace: 300 });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    b.ws.send(JSON.stringify({ type: 'send', id: 'early', text: 'too early' }));
    b.ws.send(JSON.stringify({ type: 'takeover' }));
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).toEqual(['occupied', 'hello']);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(a.events.some((e) => e.kind === 'user')).toBe(false);
  });

  it('takeover closes the owner with 4001 and replays to the new one', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'first' }));
    await until(() => a.events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    b.ws.send(JSON.stringify({ type: 'takeover' }));
    expect(await a.closed).toBe(4001);
    expect(kinds(a)).toContain('taken-over');
    await until(() => kinds(b).filter((k) => k === 'hello').length === 2);
    const replay = b.events.find((e) => e.kind === 'replay') as Extract<ServerEvent, { kind: 'replay' }>;
    expect(JSON.stringify(replay.events)).toContain('first');
    // the new owner works: its send reaches the agent
    b.ws.send(JSON.stringify({ type: 'send', id: 'u2', text: 'second' }));
    await until(() => b.events.some((e) => e.kind === 'user' && e.id === 'u2'));
  });

  it('after a restart the non-passive tab owns the window even when the passive (occupied) one reconnects first', async () => {
    const s = await boot();
    const a = await connect(`${s.url}?tab=A`);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(`${s.url}?tab=B`);
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).toEqual(['occupied', 'hello']);
    a.ws.terminate();
    b.ws.terminate();
    await new Promise((r) => setTimeout(r, 100)); // the server notices both closes
    // both reconnect with no owner: B (occupied before, so passive) is first
    const b2 = await connect(`${s.url}?tab=B&passive=1`);
    const a2 = await connect(`${s.url}?tab=A`);
    await until(() => kinds(a2).includes('hello') && kinds(b2).includes('hello'));
    expect(kinds(a2)).toContain('replay');
    expect(kinds(b2)).toEqual(['occupied', 'hello']);
  });

  it('a passive socket alone gets occupied, not the window', async () => {
    const s = await boot();
    const p = await connect(`${s.url}?tab=P&passive=1`);
    await until(() => kinds(p).includes('hello'));
    expect(kinds(p)).toEqual(['occupied', 'hello']);
    expect((await info(s.url)).clients).toBe(0);
    // it can still take the window over explicitly
    p.ws.send(JSON.stringify({ type: 'takeover' }));
    await until(() => kinds(p).includes('replay'));
    expect((await info(s.url)).clients).toBe(1);
  });

  it('after a takeover the old socket is occupied: a message it already had in flight is ignored', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    // A sends the moment it hears of the takeover: its close is still in progress on the server side
    a.ws.on('message', (d) => {
      if (JSON.parse(String(d)).kind === 'taken-over') a.ws.send(JSON.stringify({ type: 'send', id: 'late', text: 'from the old owner' }));
    });
    b.ws.send(JSON.stringify({ type: 'takeover' }));
    await a.closed;
    await until(() => kinds(b).includes('replay'));
    await new Promise((r) => setTimeout(r, 200));
    expect(b.events.some((e) => e.kind === 'user' && e.id === 'late')).toBe(false);
  });

  it('owner closing within the grace makes the newcomer the owner', async () => {
    const s = await boot({ grace: 400 });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    a.ws.close(1000); // a reload: the old socket goes away while the new one waits
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).not.toContain('occupied');
    expect(kinds(b)).toContain('replay');
  });

  it('a newcomer past the grace is told occupied; a closed newcomer is never attached', async () => {
    const s = await boot({ grace: 50 });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const gone = await connect(s.url);
    gone.ws.terminate();
    await new Promise((r) => setTimeout(r, 120));
    expect((await info(s.url)).clients).toBe(1);
  });

  it('owner with no pong is terminated', async () => {
    const s = await boot({ heartbeat: 60 });
    const a = await connect(s.url, { autoPong: false });
    await until(() => kinds(a).includes('hello'));
    await a.closed; // the second tick finds the first ping unanswered
    // the window is free again: a newcomer is the owner at once
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).not.toContain('occupied');
  });

  it('the owner reconnecting with its tab id is attached at once, no grace and no occupied', async () => {
    const s = await boot({ grace: 5000 }); // a grace this long would fail the test if it were waited
    const a = await connect(`${s.url}/ws?tab=T1`);
    await until(() => kinds(a).includes('hello'));
    // A's network died: the server still holds its socket (no close frame). The same page comes back
    const a2 = await connect(`${s.url}/ws?tab=T1`);
    await until(() => kinds(a2).includes('hello'));
    expect(kinds(a2)).not.toContain('occupied');
    expect(kinds(a2)).toContain('replay');
    await a.closed; // the zombie was terminated
    expect((await info(s.url)).clients).toBe(1);
  });

  it('a different tab id (a reload) still goes through the grace and is occupied', async () => {
    const s = await boot({ grace: 50 });
    const a = await connect(`${s.url}/ws?tab=T1`);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(`${s.url}/ws?tab=T2`);
    await until(() => kinds(b).includes('hello'));
    expect(kinds(b)).toEqual(['occupied', 'hello']);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('an owner that answers pings is kept', async () => {
    const s = await boot({ heartbeat: 40 });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    await new Promise((r) => setTimeout(r, 250));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('takeover during a turn shows the turn running', async () => {
    const s = await boot({ turns: [{ text: 'slow', delayMs: 800 }] });
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'go' }));
    await until(() => a.events.some((e) => e.kind === 'user'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    b.ws.send(JSON.stringify({ type: 'takeover' }));
    await until(() => kinds(b).includes('replay'));
    const replay = b.events.find((e) => e.kind === 'replay') as Extract<ServerEvent, { kind: 'replay' }>;
    expect(replay.events.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(true);
    expect(replay.events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end')).toBe(false);
    expect((await info(s.url)).busy).toBe(true);
    // and the turn ends for the new owner
    await until(() => b.events.some((e) => e.kind === 'agent' && e.e.t === 'turn-end'));
  });

  it('/info.clients counts the owner only', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => kinds(a).includes('hello'));
    const b = await connect(s.url);
    await until(() => kinds(b).includes('hello'));
    expect((await info(s.url)).clients).toBe(1);
    b.ws.send(JSON.stringify({ type: 'takeover' }));
    await a.closed;
    await until(() => kinds(b).filter((k) => k === 'hello').length === 2);
    expect((await info(s.url)).clients).toBe(1);
  });

  it('oneTab: false lets every socket in', async () => {
    const s = await startServer({ insecureNoAuth: true, cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, oneTab: false });
    closers.push(s.close);
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => kinds(a).includes('hello') && kinds(b).includes('hello'));
    expect(kinds(b)).toContain('replay');
    expect((await info(s.url)).clients).toBe(2);
  });
});
