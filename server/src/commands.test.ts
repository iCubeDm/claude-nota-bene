import fs from 'node:fs';
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

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cmd-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-cmd-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

const store = () => new CommentStore({ dir: path.join(home, 'comments') });
const c = (id: string): Comment => ({
  id, text: `t-${id}`, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id: 'm1' }, quote: 'q', prefix: '', suffix: '', start: 0, end: 1 },
} as unknown as Comment);

async function boot(turns: FakeTurn[] = [{ text: 'hello' }]) {
  const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend(turns), webDist: dist });
  closers.push(s.close);
  return s;
}

type Client = { ws: WebSocket; events: ServerEvent[]; send(m: unknown): void };
async function connect(url: string): Promise<Client> {
  const ws = new WebSocket(url.replace('http', 'ws'));
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events, send: (m) => ws.send(JSON.stringify(m)) };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sdkType = (e: ServerEvent) => (e.kind === 'sdk' ? (e.m as { type: string; subtype?: string }) : null);
const results = (cl: Client) => cl.events.filter((e) => sdkType(e)?.type === 'result');
const replays = (cl: Client) => cl.events.filter((e) => e.kind === 'replay');
const lastComments = (cl: Client) => {
  const all = cl.events.filter((e) => e.kind === 'comments');
  const e = all[all.length - 1];
  return e && e.kind === 'comments' ? e.items : undefined;
};
const sessions = (cl: Client) => cl.events.filter((e) => e.kind === 'session');
const errors = (cl: Client) => cl.events.filter((e) => e.kind === 'server-error');

describe('compact and clear', () => {
  it('/compact is shown as a user event, emits the boundary and a result', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.send({ type: 'command', name: 'compact' });
    await until(() => results(a).length === 1);
    expect(a.events.find((e) => e.kind === 'user')).toMatchObject({ text: '/compact' });
    const b = a.events.map(sdkType).find((m) => m?.subtype === 'compact_boundary') as unknown as { compact_metadata: { pre_tokens: number } };
    expect(b.compact_metadata.pre_tokens).toBe(12000);
    // the boundary is stored: a reconnecting client sees it
    const late = await connect(s.url);
    await until(() => replays(late).length === 1);
    const r = replays(late)[0]!;
    expect(r.kind === 'replay' && r.events.some((e) => sdkType(e)?.subtype === 'compact_boundary')).toBe(true);
  });

  it('pre_tokens is scriptable', async () => {
    const s = await boot([{ text: 'x', compactPreTokens: 54321 }]);
    const a = await connect(s.url);
    a.send({ type: 'command', name: 'compact' });
    await until(() => results(a).length === 1);
    const b = a.events.map(sdkType).find((m) => m?.subtype === 'compact_boundary') as unknown as { compact_metadata: { pre_tokens: number } };
    expect(b.compact_metadata.pre_tokens).toBe(54321);
  });

  it('/clear: a reconnecting socket has no old turns, the session id is new, saved, and comments start empty', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.send({ type: 'comments', sessionId: null, items: [c('old')] });
    await until(() => lastComments(a)?.length === 1);
    a.send({ type: 'send', id: 'u1', text: 'hi' });
    await until(() => results(a).length === 1);
    await until(() => store().get('fake-session').length === 1);
    const before = fs.readFileSync(path.join(home, 'comments', fs.readdirSync(path.join(home, 'comments')).find((f) => f.includes('fake-session'))!), 'utf8');

    a.send({ type: 'command', name: 'clear' });
    await until(() => sessions(a).some((e) => e.kind === 'session' && e.id !== 'fake-session'));
    const sess = sessions(a).at(-1)!;
    const newId = sess.kind === 'session' ? sess.id : null;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sess).toMatchObject({ title: null });
    // the live socket got an empty replay
    const lastReplay = replays(a).at(-1)!;
    expect(lastReplay.kind === 'replay' && lastReplay.events).toEqual([]);
    await until(() => lastComments(a)?.length === 0);
    // the new id's set is empty, the old one untouched on disk and in the store
    expect(store().get(newId!)).toEqual([]);
    expect(store().get('fake-session')).toEqual([c('old')]);
    const dir = path.join(home, 'comments');
    expect(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.includes('fake-session'))!), 'utf8')).toBe(before);
    expect(lastSession('/proj')).toBe(newId);

    // a reconnecting socket: no old turns
    const late = await connect(s.url);
    await until(() => replays(late).length === 1);
    const r = replays(late)[0]!;
    expect(r.kind === 'replay' && r.events.filter((e) => e.kind === 'user' || sdkType(e)?.type === 'assistant')).toEqual([]);
    await until(() => lastComments(late) !== undefined);
    expect(lastComments(late)).toEqual([]);

    // the next turn continues in the new session: nothing from the old set is adopted, and the id stays
    a.send({ type: 'send', id: 'u2', text: 'again' });
    await until(() => results(a).length === 2);
    expect(store().get(newId!)).toEqual([]);
    expect(errors(a)).toEqual([]);
  });

  it('a command is rejected while the agent is busy', async () => {
    const s = await boot([{ text: 'x'.repeat(80), chunk: 1, delayMs: 10 }]);
    const a = await connect(s.url);
    a.send({ type: 'send', id: 'u1', text: 'hi' });
    await until(() => a.events.some((e) => e.kind === 'sdk'));
    a.send({ type: 'command', name: 'clear' });
    a.send({ type: 'command', name: 'compact' });
    await until(() => errors(a).length === 2);
    expect(errors(a)[0]).toMatchObject({ where: 'busy' });
    expect(a.events.some((e) => e.kind === 'user' && e.text.startsWith('/'))).toBe(false);
    a.send({ type: 'interrupt' });
    await until(() => results(a).length === 1);
    // idle again: the command goes through
    a.send({ type: 'command', name: 'compact' });
    await until(() => results(a).length === 2);
  });

  it('busy ends after a /clear', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.send({ type: 'command', name: 'clear' });
    await until(() => sessions(a).some((e) => e.kind === 'session' && e.id !== null && e.id !== 'fake-session'));
    a.send({ type: 'command', name: 'compact' });
    await until(() => results(a).length === 1);
    expect(errors(a)).toEqual([]);
  });
});

describe('idle compaction', () => {
  const idle = { idleMs: 150, cacheMs: 60_000, minTokens: 100_000 };
  const big = { text: 'hello', context: { used: 500_000, max: 1_000_000, pct: 50 } };
  async function bootIdle(turns: FakeTurn[], off = false) {
    const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend(turns), webDist: dist, idle, idleOffInSettings: () => off });
    closers.push(s.close);
    return s;
  }
  const idleUsers = (cl: Client) => cl.events.filter((e) => e.kind === 'user' && e.idle === true);
  const states = (cl: Client) => cl.events.flatMap((e) => (e.kind === 'idle-compact' ? [e.state] : []));

  it('a quiet session with a big context is compacted once, shown as the server\'s own /compact', async () => {
    const s = await bootIdle([big]);
    const a = await connect(s.url);
    await until(() => states(a).length === 1);
    expect(states(a)[0]).toEqual({ on: true, blocked: false, minutes: 0, minTokens: 100_000 });
    a.send({ type: 'send', id: 'u1', text: 'hi' });
    await until(() => results(a).length === 1);
    await until(() => idleUsers(a).length === 1);
    expect(idleUsers(a)[0]).toMatchObject({ text: '/compact', idle: true });
    await until(() => results(a).length === 2);
    expect(a.events.some((e) => sdkType(e)?.subtype === 'compact_boundary')).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(idleUsers(a)).toHaveLength(1); // the compaction disarmed it; its own result does not count as a quiet turn
    expect(errors(a)).toEqual([]);
  });

  it('activity holds it off; turned off for the project it never runs, and the setting is announced and kept', async () => {
    const s = await bootIdle([big]);
    const a = await connect(s.url);
    a.send({ type: 'send', id: 'u1', text: 'hi' });
    await until(() => results(a).length === 1);
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 80)); a.send({ type: 'activity' }); }
    expect(idleUsers(a)).toHaveLength(0);
    a.send({ type: 'idle-compact', on: false });
    await until(() => states(a).some((x) => !x.on));
    await new Promise((r) => setTimeout(r, 400));
    expect(idleUsers(a)).toHaveLength(0);
    const late = await connect(s.url);
    await until(() => states(late).length === 1);
    expect(states(late)[0]!.on).toBe(false);
  });

  it('blocked by Claude Code settings: announced as blocked and never runs', async () => {
    const s = await bootIdle([big], true);
    const a = await connect(s.url);
    await until(() => states(a).length === 1);
    expect(states(a)[0]).toMatchObject({ on: true, blocked: true });
    a.send({ type: 'send', id: 'u1', text: 'hi' });
    await until(() => results(a).length === 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(idleUsers(a)).toHaveLength(0);
  });

  it('a small context is left alone', async () => {
    const s = await bootIdle([{ text: 'hello', context: { used: 5000, max: 1_000_000, pct: 1 } }]);
    const a = await connect(s.url);
    a.send({ type: 'send', id: 'u1', text: 'hi' });
    await until(() => results(a).length === 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(idleUsers(a)).toHaveLength(0);
  });
});
