import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { reduceTasks, type ServerEvent, type TaskOutputView } from '@nota-bene/shared';
import { fakeBackend, type FakeShell, type FakeTurn } from './agent/fake.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tasks-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tasks-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

const shells: FakeShell[] = [{ taskId: 'sh1', chunks: ['one\n', 'two\n', 'three\n'] }, { taskId: 'big', chunks: ['x'.repeat(5000), 'y'.repeat(5000)] }];
const turn: FakeTurn = {
  text: 'started',
  frames: [
    { type: 'system', subtype: 'task_started', task_id: 'sh1', description: 'tail -f build.log', task_type: 'local_bash', tool_use_id: 'toolu_sh' },
    { type: 'system', subtype: 'task_started', task_id: 'ag1', description: 'Explore', task_type: 'local_agent', tool_use_id: 'toolu_ag' },
    { type: 'system', subtype: 'task_started', task_id: 'big', description: 'dd', task_type: 'local_bash' },
  ],
};

async function boot(o: { background?: boolean | 'throw' } = {}) {
  const backend = fakeBackend([turn], { shells, ...o });
  const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false, resume: 'fake-session' });
  closers.push(s.close);
  const ws = new WebSocket(s.url.replace('http', 'ws'));
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'go' }));
  await until(() => tasks(events).big !== undefined);
  return { s, ws, events, backend };
}
const tasks = (events: ServerEvent[]) => reduceTasks({}, { kind: 'replay', events });
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const get = (s: { url: string }, q: string) => fetch(`${s.url}/task-output?${q}`);
const errors = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { kind: 'server-error' }> => e.kind === 'server-error');

describe('task-stop / task-background', () => {
  it('task-stop reaches the backend, and the task ends as stopped', async () => {
    const { ws, events, backend } = await boot();
    expect(tasks(events).sh1).toMatchObject({ status: 'running', kind: 'shell' });
    ws.send(JSON.stringify({ type: 'task-stop', id: 'sh1' }));
    await until(() => tasks(events).sh1?.status === 'stopped');
    expect(backend.stops).toEqual(['sh1']);
    expect(tasks(events).ag1?.status).toBe('running');
  });

  it('task-background reaches the backend with the tool-use id; a moved task is silent', async () => {
    const { ws, events, backend } = await boot();
    ws.send(JSON.stringify({ type: 'task-background', toolUseId: 'toolu_sh' }));
    await until(() => backend.backgrounds.length === 1);
    expect(backend.backgrounds).toEqual(['toolu_sh']);
    await new Promise((r) => setTimeout(r, 30));
    expect(errors(events)).toEqual([]);
  });

  it('a false answer (nothing in the foreground) and a throw come back as server-error with the reason', async () => {
    const none = await boot({ background: false });
    none.ws.send(JSON.stringify({ type: 'task-background', toolUseId: 'toolu_sh' }));
    await until(() => errors(none.events).length === 1);
    expect(errors(none.events)[0]).toMatchObject({ where: 'task' });
    expect(errors(none.events)[0]!.message).toMatch(/foreground/);
    const off = await boot({ background: 'throw' });
    off.ws.send(JSON.stringify({ type: 'task-background', toolUseId: 'toolu_sh' }));
    await until(() => errors(off.events).length === 1);
    expect(errors(off.events)[0]).toMatchObject({ where: 'task', message: 'background tasks are disabled' });
  });

  it('a malformed one is an error event and reaches no backend', async () => {
    const { ws, events, backend } = await boot();
    ws.send(JSON.stringify({ type: 'task-stop', id: '../x' }));
    ws.send(JSON.stringify({ type: 'task-background' }));
    await until(() => errors(events).length === 2);
    expect(backend.stops).toEqual([]);
    expect(backend.backgrounds).toEqual([]);
  });
});

describe('GET /task-output', () => {
  it('200: a running shell task\'s output grows with every read; the view says it still runs', async () => {
    const { s } = await boot();
    const read = async () => (await (await get(s, 'session=fake-session&task=sh1')).json()) as TaskOutputView;
    expect(await read()).toEqual({ output: 'one\n', totalBytes: 4, truncated: false, running: true });
    expect((await read()).output).toBe('one\ntwo\n');
  });

  it('after the stop: running false, the output no longer grows', async () => {
    const { s, ws, events } = await boot();
    await get(s, 'session=fake-session&task=sh1');
    ws.send(JSON.stringify({ type: 'task-stop', id: 'sh1' }));
    await until(() => tasks(events).sh1?.status === 'stopped');
    const a = await (await get(s, 'session=fake-session&task=sh1')).json() as TaskOutputView;
    const b = await (await get(s, 'session=fake-session&task=sh1')).json() as TaskOutputView;
    expect(a.running).toBe(false);
    expect(b.output).toBe(a.output);
  });

  it('the tail of a long output is flagged truncated', async () => {
    const { s } = await boot();
    await get(s, 'session=fake-session&task=big');
    const v = await (await get(s, 'session=fake-session&task=big')).json() as TaskOutputView;
    expect(v).toMatchObject({ truncated: true, totalBytes: 10000 });
    expect(Buffer.byteLength(v.output)).toBe(8192);
  });

  it('404 for a task the server does not know and for one that is not a shell; 409 for another session; 400 for bad ids; 405 for POST', async () => {
    const { s } = await boot();
    expect((await get(s, 'session=fake-session&task=nope')).status).toBe(404);
    expect((await get(s, 'session=fake-session&task=ag1')).status).toBe(404);
    const r = await get(s, 'session=other-session&task=sh1');
    expect(r.status).toBe(409);
    expect(await r.text()).not.toContain('one');
    for (const q of ['session=..%2Fx&task=sh1', 'session=fake-session&task=..%2F..', 'session=fake-session&task=a%2Fb', 'session=fake-session', 'task=sh1', 'session=fake-session&task=']) {
      expect((await get(s, q)).status, q).toBe(400);
    }
    expect((await fetch(`${s.url}/task-output?session=fake-session&task=sh1`, { method: 'POST', headers: { origin: s.url } })).status).toBe(405);
  });
});
