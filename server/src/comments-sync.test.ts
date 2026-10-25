import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import type { AgentBackend } from './agent/types.ts';
import { CommentStore } from './comments.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-csync-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-csync-dist-'));
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
const c = (id: string, extra: Partial<Comment> = {}): Comment => ({
  id, text: `t-${id}`, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id: 'm1' }, quote: 'q', prefix: '', suffix: '', start: 0, end: 1 },
  ...extra,
} as unknown as Comment);

async function boot(o: { resume?: string; backend?: AgentBackend } = {}) {
  const s = await startServer({
    cwd: '/proj', port: 0, backend: o.backend ?? fakeBackend([{ text: 'hello' }]), webDist: dist,
    ...(o.resume ? { resume: o.resume } : {}),
  });
  closers.push(s.close);
  return s;
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

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const lastComments = (cl: Client) => {
  const all = cl.events.filter((e) => e.kind === 'comments');
  const e = all[all.length - 1];
  return e && e.kind === 'comments' ? e.items : undefined;
};
const isResult = (e: ServerEvent) => e.kind === 'sdk' && (e.m as { type: string }).type === 'result';

describe('comment sync', () => {
  it('a new client receives the stored comments after the replay', async () => {
    store().set('sess-1', [c('a')]);
    const s = await boot({ resume: 'sess-1' });
    const cl = await connect(s.url);
    await until(() => cl.events.length >= 2);
    expect(cl.events[0]!.kind).toBe('replay');
    expect(cl.events[1]).toEqual({ kind: 'comments', items: [c('a')] });
  });

  it('comments never enter the replay history', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a')] }));
    await until(() => lastComments(a)?.length === 1);
    const b = await connect(s.url);
    await until(() => b.events.length >= 2);
    const first = b.events[0]!;
    expect(first.kind === 'replay' && first.events.some((e) => e.kind === 'comments')).toBe(false);
    expect(lastComments(b)).toEqual([c('a')]);
  });

  it('comments from one client reach the other', async () => {
    const s = await boot();
    const a = await connect(s.url);
    const b = await connect(s.url);
    await until(() => lastComments(a) !== undefined && lastComments(b) !== undefined);
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a')] }));
    await until(() => lastComments(b)?.length === 1);
    expect(lastComments(b)).toEqual([c('a')]);
    expect(lastComments(a)).toEqual([c('a')]);
  });

  it('a send with commentIds marks them sent in both clients', async () => {
    const s = await boot();
    const a = await connect(s.url);
    const b = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a'), c('b')] }));
    await until(() => lastComments(b)?.length === 2);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi', commentIds: ['a'] }));
    await until(() => a.events.some(isResult));
    for (const cl of [a, b]) {
      await until(() => lastComments(cl)?.find((x) => x.id === 'a')?.status === 'sent');
      const items = lastComments(cl)!;
      expect(items.find((x) => x.id === 'a')).toMatchObject({ status: 'sent', sentIn: 'u1' });
      expect(items.find((x) => x.id === 'b')).toMatchObject({ status: 'pending' });
    }
  });

  it('comments made before init are persisted under the session id after it', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a')] }));
    await until(() => lastComments(a)?.length === 1);
    expect(store().get('fake-session')).toEqual([]);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => a.events.some(isResult));
    expect(store().get('fake-session')).toEqual([c('a')]);
  });

  it('resume loads the session\'s comments', async () => {
    store().set('sess-2', [c('x'), c('y', { status: 'sent', sentIn: 'u0' })]);
    const s = await boot({ resume: 'sess-2' });
    const a = await connect(s.url);
    await until(() => lastComments(a) !== undefined);
    expect(lastComments(a)).toHaveLength(2);
    expect(lastComments(a)![1]).toMatchObject({ status: 'sent', sentIn: 'u0' });
  });

  it('a session id change broadcasts the new id\'s stored set', async () => {
    store().set('other-id', [c('o')]);
    const inner = fakeBackend([{ text: 'hello' }]);
    const backend: AgentBackend = {
      history: inner.history,
      start: (o) => inner.start({ ...o, resume: 'other-id' }),
    };
    const s = await boot({ backend });
    const a = await connect(s.url);
    await until(() => lastComments(a) !== undefined);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => lastComments(a)?.some((x) => x.id === 'o') === true);
  });
  it('a racing client cannot turn a sent comment back to pending or drop it', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a'), c('b')] }));
    await until(() => lastComments(a)?.length === 2);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi', commentIds: ['a'] }));
    await until(() => lastComments(a)?.find((x) => x.id === 'a')?.status === 'sent');
    // a stale full set from another window: 'a' still pending
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a', { text: 'stale' }), c('b')] }));
    await until(() => lastComments(a)?.find((x) => x.id === 'a')?.text === 't-a' && a.events.filter((e) => e.kind === 'comments').length >= 4);
    expect(lastComments(a)!.find((x) => x.id === 'a')).toMatchObject({ status: 'sent', sentIn: 'u1', text: 't-a' });
    // a set that lacks the sent comment keeps it
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('b')] }));
    await until(() => a.events.filter((e) => e.kind === 'comments').length >= 5);
    expect(lastComments(a)!.map((x) => [x.id, x.status])).toEqual([['b', 'pending'], ['a', 'sent']]);
  });

  it('a failing comments write is reported to the client and the server keeps serving', async () => {
    store().set('sess-ro', [c('a')]);
    const s = await boot({ resume: 'sess-ro' });
    const a = await connect(s.url);
    await until(() => lastComments(a) !== undefined);
    const dir = path.join(home, 'comments');
    fs.chmodSync(dir, 0o555);
    closers.push(async () => { fs.chmodSync(dir, 0o755); });
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [c('a'), c('b')] }));
    await until(() => a.events.some((e) => e.kind === 'server-error'));
    expect(a.events.find((e) => e.kind === 'server-error')).toMatchObject({ where: 'comments' });
    expect(store().get('sess-ro')).toEqual([c('a')]);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => a.events.some(isResult));
  });

  it('a failing markSent still delivers the send', async () => {
    store().set('sess-ro2', [c('a')]);
    const s = await boot({ resume: 'sess-ro2' });
    const a = await connect(s.url);
    await until(() => lastComments(a) !== undefined);
    const dir = path.join(home, 'comments');
    fs.chmodSync(dir, 0o555);
    closers.push(async () => { fs.chmodSync(dir, 0o755); });
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi', commentIds: ['a'] }));
    await until(() => a.events.some(isResult));
    expect(a.events.find((e) => e.kind === 'server-error')).toMatchObject({ where: 'comments' });
  });
});
