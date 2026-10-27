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
const isResult = (e: ServerEvent) => e.kind === 'agent' && e.e.t === 'turn-end';

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
      ...inner,
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
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: 'fake-session', items: [c('a', { text: 'stale' }), c('b')] }));
    await until(() => lastComments(a)?.find((x) => x.id === 'a')?.text === 't-a' && a.events.filter((e) => e.kind === 'comments').length >= 4);
    expect(lastComments(a)!.find((x) => x.id === 'a')).toMatchObject({ status: 'sent', sentIn: 'u1', text: 't-a' });
    // a set that lacks the sent comment keeps it
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: 'fake-session', items: [c('b')] }));
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
    a.ws.send(JSON.stringify({ type: 'comments', sessionId: 'sess-ro', items: [c('a'), c('b')] }));
    await until(() => a.events.some((e) => e.kind === 'server-error'));
    expect(a.events.find((e) => e.kind === 'server-error')).toMatchObject({ where: 'comments' });
    expect(a.events.find((e) => e.kind === 'server-error')).not.toMatchObject({ message: 'stale session' });
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

describe('mark files follow their comment', () => {
  it('a media comment dropped from the set loses its folder in the project; a kept one and the merge stand', async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-csync-proj-')));
    closers.push(async () => fs.rmSync(proj, { recursive: true, force: true }));
    const s = await startServer({ cwd: proj, port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist });
    closers.push(s.close);
    const A = '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
    const B = '1f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
    const media = (id: string) => c(id, {
      anchor: { kind: 'media', source: { kind: 'file', path: 'a.png' }, width: 4, height: 4, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }] },
    } as Partial<Comment>);
    const cl = await connect(s.url);
    cl.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [media(A), media(B)] }));
    await until(() => lastComments(cl)?.length === 2);
    for (const id of [A, B]) {
      fs.mkdirSync(path.join(proj, '.nota-bene', 'marks', id), { recursive: true });
      fs.writeFileSync(path.join(proj, '.nota-bene', 'marks', id, 'frame.jpg'), 'x');
    }
    cl.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [media(B)] }));
    await until(() => lastComments(cl)?.length === 1);
    await until(() => !fs.existsSync(path.join(proj, '.nota-bene', 'marks', A)));
    expect(fs.existsSync(path.join(proj, '.nota-bene', 'marks', B, 'frame.jpg'))).toBe(true);
  });

  it('a failing removal is reported and the merge still stands', async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-csync-proj-')));
    const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-csync-out-')));
    closers.push(async () => { fs.rmSync(proj, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(out, 'marks', '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab'), { recursive: true });
    fs.symlinkSync(out, path.join(proj, '.nota-bene'));
    const s = await startServer({ cwd: proj, port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist });
    closers.push(s.close);
    const A = '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab';
    const media = c(A, {
      anchor: { kind: 'media', source: { kind: 'file', path: 'a.png' }, width: 4, height: 4, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }] },
    } as Partial<Comment>);
    const cl = await connect(s.url);
    cl.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [media] }));
    await until(() => lastComments(cl)?.length === 1);
    cl.ws.send(JSON.stringify({ type: 'comments', sessionId: null, items: [] }));
    await until(() => lastComments(cl)?.length === 0);
    await until(() => cl.events.some((e) => e.kind === 'server-error' && e.where === 'marks'));
    expect(fs.existsSync(path.join(out, 'marks', A))).toBe(true); // never followed the symlink
  });
});

describe('sent comments keep their mark files', () => {
  it('a SENT media comment omitted from an incoming set keeps its folder, and DELETE /marks answers 409 for it', async () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-csync-proj-')));
    closers.push(async () => fs.rmSync(proj, { recursive: true, force: true }));
    const A = '0f8b2c4e-1a2b-4c3d-9e8f-0123456789ab'; // sent
    const B = '1f8b2c4e-1a2b-4c3d-9e8f-0123456789ab'; // pending
    const media = (id: string, extra: Partial<Comment> = {}) => c(id, {
      anchor: { kind: 'media', source: { kind: 'file', path: 'a.png' }, width: 4, height: 4, shapes: [{ kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1 }] },
      ...extra,
    } as Partial<Comment>);
    store().set('sess-m', [media(A, { status: 'sent', sentIn: 'u0' }), media(B)]);
    for (const id of [A, B]) {
      fs.mkdirSync(path.join(proj, '.nota-bene', 'marks', id), { recursive: true });
      fs.writeFileSync(path.join(proj, '.nota-bene', 'marks', id, 'frame.jpg'), 'x');
    }
    const s = await startServer({ cwd: proj, port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, resume: 'sess-m' });
    closers.push(s.close);
    const cl = await connect(s.url);
    await until(() => lastComments(cl)?.length === 2);
    cl.ws.send(JSON.stringify({ type: 'comments', sessionId: 'sess-m', items: [] }));
    await until(() => !fs.existsSync(path.join(proj, '.nota-bene', 'marks', B))); // the pending one goes
    expect(lastComments(cl)!.map((x) => [x.id, x.status])).toEqual([[A, 'sent']]);
    expect(fs.existsSync(path.join(proj, '.nota-bene', 'marks', A, 'frame.jpg'))).toBe(true);
    const origin = s.url.replace(/\/$/, '');
    const d = await fetch(`${origin}/marks/${A}`, { method: 'DELETE', headers: { origin } });
    expect(d.status).toBe(409);
    expect(fs.existsSync(path.join(proj, '.nota-bene', 'marks', A, 'frame.jpg'))).toBe(true);
  });
});
