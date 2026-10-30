import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLAUDE_CAPABILITIES, PROTOCOL, type Capabilities, type ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import { HistoryArchive } from './archive.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-server-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-server-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(extra: { experimental3d?: boolean } = {}) {
  const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, oneTab: false, ...extra });
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

const isResult = (e: ServerEvent) => e.kind === 'agent' && e.e.t === 'turn-end';

describe('server', () => {
  it('chat round-trip over ws', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => c.events.some(isResult));
    expect(c.events.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(true);
  });

  it('malformed message does not kill the server', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.ws.send('{nope');
    c.ws.send('{"type":"x"}');
    await until(() => c.events.filter((e) => e.kind === 'server-error').length === 2);
    const r = await fetch(`${s.url}/info`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ root: '/proj' });
  });

  it('a new socket gets the current stats, and stats never enter the replay', async () => {
    const hot = { used: 180000, max: 200000, pct: 90 };
    const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello', context: hot }]), webDist: dist, oneTab: false });
    closers.push(s.close);
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => a.events.some((e) => e.kind === 'stats' && e.stats.context?.pct === 90));
    const b = await connect(s.url);
    await until(() => b.events.some((e) => e.kind === 'stats'));
    expect(b.events.find((e) => e.kind === 'stats')).toMatchObject({ stats: { context: hot } });
    const replay = b.events.find((e) => e.kind === 'replay') as Extract<ServerEvent, { kind: 'replay' }>;
    expect(replay.events.some((e) => e.kind === 'stats')).toBe(false);
  });

  it('a second client gets the replay', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
    await until(() => a.events.some(isResult));
    const b = await connect(s.url);
    await until(() => b.events.length > 0);
    const first = b.events[0]!;
    expect(first.kind).toBe('replay');
    if (first.kind === 'replay') expect(first.events.some((e) => e.kind === 'user' && e.id === 'u1')).toBe(true);
  });

  it('every new socket hears hello with the protocol, after the state it is sent on connect', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => a.events.some((e) => e.kind === 'hello'));
    const kinds = a.events.map((e) => e.kind);
    expect(a.events.find((e) => e.kind === 'hello')).toEqual({ kind: 'hello', protocol: PROTOCOL, capabilities: { ...CLAUDE_CAPABILITIES, model3d: false } });
    expect(kinds.indexOf('hello')).toBeGreaterThan(kinds.indexOf('stats'));
  });

  it('every new socket gets the mode, and a mode message is applied and broadcast', async () => {
    const s = await boot();
    const a = await connect(s.url);
    await until(() => a.events.some((e) => e.kind === 'mode'));
    expect(a.events.find((e) => e.kind === 'mode')).toEqual({ kind: 'mode', mode: 'auto' });
    a.ws.send(JSON.stringify({ type: 'mode', mode: 'plan' }));
    await until(() => a.events.filter((e) => e.kind === 'mode').length === 2);
    const b = await connect(s.url);
    await until(() => b.events.some((e) => e.kind === 'mode'));
    expect(b.events.find((e) => e.kind === 'mode')).toEqual({ kind: 'mode', mode: 'plan' });
    const replay = b.events[0]!;
    if (replay.kind === 'replay') expect(replay.events.some((e) => e.kind === 'mode')).toBe(false); // live state, not history
  });

  it('every new socket gets the model list and the current model; a model message is applied, answered with its ack and broadcast', async () => {
    const models = [{ value: 'sonnet', name: 'Sonnet', description: '', efforts: ['low', 'high'] }, { value: 'opus', name: 'Opus', description: '' }] as const;
    const backend = fakeBackend([{ text: 'hello' }], { models: models.map((m) => ({ ...m, efforts: 'efforts' in m ? [...m.efforts] : undefined })) as never });
    const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false });
    closers.push(s.close);
    const a = await connect(s.url);
    await until(() => a.events.some((e) => e.kind === 'models'));
    expect(a.events.find((e) => e.kind === 'model')).toEqual({ kind: 'model', model: null });
    a.ws.send(JSON.stringify({ type: 'model', model: 'sonnet', effort: 'high', id: 'm1' }));
    await until(() => a.events.some((e) => e.kind === 'model' && e.ack === 'm1'));
    expect(a.events.findLast((e) => e.kind === 'model')).toEqual({ kind: 'model', model: 'sonnet', effort: 'high', ack: 'm1' });
    const b = await connect(s.url); // a reload gets the list and the choice at once
    await until(() => b.events.some((e) => e.kind === 'model'));
    expect(b.events.find((e) => e.kind === 'model')).toEqual({ kind: 'model', model: 'sonnet', effort: 'high' });
    expect(b.events.find((e) => e.kind === 'models')).toMatchObject({ models: [{ value: 'sonnet' }, { value: 'opus' }] });
    expect(backend.setModels).toEqual(['sonnet']);
  });

  it('every new socket gets the slash commands, filtered: the user\'s first, the allowlisted builtins, nothing bound to a terminal', async () => {
    const backend = fakeBackend([{ text: 'hello' }], {
      commands: [
        { name: 'model', description: 'm', builtin: true }, { name: 'compact', description: 'c', argumentHint: '[how]', builtin: true },
        { name: 'ping', description: 'p' }, { name: 'doctor', description: 'd', builtin: true }, { name: 'color', description: 'x' },
      ],
      terminalCommands: ['doctor', 'color'],
    });
    const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false });
    closers.push(s.close);
    const a = await connect(s.url);
    const want = { kind: 'commands', commands: [{ name: 'ping', description: 'p' }, { name: 'compact', description: 'c', hint: '[how]', builtin: true }] };
    await until(() => a.events.some((e) => e.kind === 'commands' && e.commands.length > 0));
    expect(a.events.findLast((e) => e.kind === 'commands')).toEqual(want);
    const b = await connect(s.url); // a later socket gets the list with the other state, not through the replay
    await until(() => b.events.some((e) => e.kind === 'commands'));
    expect(b.events.findLast((e) => e.kind === 'commands')).toEqual(want);
    const replay = b.events[0]!;
    if (replay.kind === 'replay') expect(replay.events.some((e) => e.kind === 'commands')).toBe(false);
  });

  it('an allow that carries a modified input still runs the original input', async () => {
    const seen: unknown[] = [];
    const base = fakeBackend([{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]);
    // the agent side: what the backend's ask resolves with is what the SDK adapter turns into updatedInput
    const backend = { ...base, start: (o: Parameters<typeof base.start>[0]) => base.start({ ...o, ask: async (...a) => { const r = await o.ask(...a); seen.push(r); return r; } }) };
    const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false });
    closers.push(s.close);
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'run' }));
    await until(() => c.events.some((e) => e.kind === 'permission'));
    const p = c.events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    c.ws.send(JSON.stringify({ type: 'permission', id: p.id, allow: true, input: { command: 'rm -rf /' } }));
    await until(() => seen.length === 1);
    expect(seen[0]).toBe(true); // a plain allow: the adapter echoes the ORIGINAL input
  });

  const prevSup = process.env.NOTA_BENE_SUPERVISED;
  const prevLauncher = process.env.NOTA_BENE_LAUNCHER_PID;
  const restoreSup = () => {
    if (prevSup === undefined) delete process.env.NOTA_BENE_SUPERVISED; else process.env.NOTA_BENE_SUPERVISED = prevSup;
    if (prevLauncher === undefined) delete process.env.NOTA_BENE_LAUNCHER_PID; else process.env.NOTA_BENE_LAUNCHER_PID = prevLauncher;
  };
  // supervised = the env says so AND the launcher named in it is still our parent
  const supervise = (launcher = process.ppid) => {
    process.env.NOTA_BENE_SUPERVISED = '1';
    process.env.NOTA_BENE_LAUNCHER_PID = String(launcher);
  };

  it('/info.supervised follows NOTA_BENE_SUPERVISED, and only while the launcher is the parent', async () => {
    const s = await boot();
    const sup = async () => ((await (await fetch(`${s.url}/info`)).json()) as { supervised: boolean }).supervised;
    try {
      delete process.env.NOTA_BENE_SUPERVISED;
      expect(await sup()).toBe(false);
      supervise();
      expect(await sup()).toBe(true);
      supervise(process.ppid + 100000); // an orphan: its launcher is gone, init/launchd adopted it
      expect(await sup()).toBe(false);
    } finally {
      restoreSup();
    }
  });

  it('/info.blender says whether a Blender is found (NOTA_BENE_BLENDER is authoritative); experimental 3D on', async () => {
    const prev = process.env.NOTA_BENE_BLENDER;
    const s = await boot({ experimental3d: true });
    const has = async () => ((await (await fetch(`${s.url}/info`)).json()) as { blender: boolean }).blender;
    try {
      process.env.NOTA_BENE_BLENDER = '/nonexistent/blender';
      expect(await has()).toBe(false);
      process.env.NOTA_BENE_BLENDER = process.execPath; // any executable file
      expect(await has()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NOTA_BENE_BLENDER; else process.env.NOTA_BENE_BLENDER = prev;
    }
  });

  describe('experimental 3D flag', () => {
    it('off (the default): /model is a 404, /info.blender is false even with a Blender configured, hello says model3d false', async () => {
      const prev = process.env.NOTA_BENE_BLENDER;
      process.env.NOTA_BENE_BLENDER = process.execPath;
      try {
        const s = await boot();
        expect((await fetch(`${s.url}/model?path=a.blend`)).status).toBe(404);
        expect(((await (await fetch(`${s.url}/info`)).json()) as { blender: boolean }).blender).toBe(false);
        const c = await connect(s.url);
        await until(() => c.events.some((e) => e.kind === 'hello'));
        const hello = c.events.find((e) => e.kind === 'hello') as { capabilities: { model3d?: boolean } };
        expect(hello.capabilities.model3d).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.NOTA_BENE_BLENDER; else process.env.NOTA_BENE_BLENDER = prev;
      }
    });

    it('on: the route exists (a missing file is not the unrouted 404), hello says model3d true', async () => {
      const s = await boot({ experimental3d: true });
      const r = await fetch(`${s.url}/model?path=a.blend`, { headers: { 'sec-fetch-site': 'same-origin' } });
      expect(await r.text()).not.toBe('not found');
      const c = await connect(s.url);
      await until(() => c.events.some((e) => e.kind === 'hello'));
      expect((c.events.find((e) => e.kind === 'hello') as { capabilities: { model3d?: boolean } }).capabilities.model3d).toBe(true);
    });

    it('NOTA_BENE_EXPERIMENTAL_3D=1 turns it on when the option is not given', async () => {
      const prev = process.env.NOTA_BENE_EXPERIMENTAL_3D;
      process.env.NOTA_BENE_EXPERIMENTAL_3D = '1';
      try {
        const s = await boot();
        const c = await connect(s.url);
        await until(() => c.events.some((e) => e.kind === 'hello'));
        expect((c.events.find((e) => e.kind === 'hello') as { capabilities: { model3d?: boolean } }).capabilities.model3d).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.NOTA_BENE_EXPERIMENTAL_3D; else process.env.NOTA_BENE_EXPERIMENTAL_3D = prev;
      }
    });
  });

  it('a taken port rejects startServer with the listen error (instead of hanging)', async () => {
    const s = await boot();
    const port = Number(new URL(s.url).port);
    const err = await startServer({ cwd: '/proj', port, backend: fakeBackend([]), webDist: dist, oneTab: false }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err).toMatchObject({ code: 'EADDRINUSE', syscall: 'listen' });
  });

  describe('GET /history (R-M7-4)', () => {
    const user = (id: string): ServerEvent => ({ kind: 'user', id, text: id, ts: 1 });
    async function bootWithArchive() {
      const a = new HistoryArchive({ dir: path.join(home, 'history') });
      a.append('fake-session', [user('a')]);
      a.append('fake-session', [user('b')]);
      a.append('other-session', [user('x')]);
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, oneTab: false, resume: 'fake-session' });
      closers.push(s.close);
      return s;
    }
    const get = (s: { url: string }, q: string) => fetch(`${s.url}/history?${q}`);

    it('a new socket\'s replay carries earlier, and each page goes one segment back', async () => {
      const s = await bootWithArchive();
      const c = await connect(s.url);
      await until(() => c.events.some((e) => e.kind === 'hello'));
      expect(c.events[0]).toMatchObject({ kind: 'replay', earlier: 2 });
      const r = await get(s, 'session=fake-session&before=3');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ events: [user('b')], segment: 2, more: true });
      expect(await (await get(s, 'session=fake-session&before=2')).json()).toEqual({ events: [user('a')], segment: 1, more: false });
      expect((await get(s, 'session=fake-session&before=1')).status).toBe(404);
    });

    it('history 409 for another session', async () => {
      const s = await bootWithArchive();
      const r = await get(s, 'session=other-session&before=2');
      expect(r.status).toBe(409);
      expect(await r.text()).not.toContain('x');
    });

    it('409 while the conversation has no id of its own: a fork before its first turn does not serve the source\'s archive', async () => {
      new HistoryArchive({ dir: path.join(home, 'history') }).append('fake-session', [user('a')]);
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist, oneTab: false, resume: 'fake-session', fork: true });
      closers.push(s.close);
      expect((await get(s, 'session=fake-session&before=2')).status).toBe(409);
    });

    it('400 for a bad id or a bad before; 405 for a POST', async () => {
      const s = await bootWithArchive();
      for (const q of ['session=..%2Fx&before=2', 'before=2', 'session=fake-session', 'session=fake-session&before=0', 'session=fake-session&before=1.5', 'session=fake-session&before=abc']) {
        expect((await get(s, q)).status, q).toBe(400);
      }
      expect((await fetch(`${s.url}/history?session=fake-session&before=2`, { method: 'POST', headers: { origin: s.url } })).status).toBe(405);
    });
  });

  describe('POST /restart-server', () => {
    afterEach(restoreSup);
    const post = (url: string, origin?: string) =>
      fetch(`${url}/restart-server`, { method: 'POST', ...(origin ? { headers: { origin } } : {}) });

    it('409 when not supervised, and never exits', async () => {
      delete process.env.NOTA_BENE_SUPERVISED;
      const codes: number[] = [];
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, oneTab: false, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, s.url)).status).toBe(409);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });

    it('403 for a foreign Origin (and for none), even when supervised', async () => {
      supervise();
      const codes: number[] = [];
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, oneTab: false, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, 'http://evil.example')).status).toBe(403);
      expect((await post(s.url)).status).toBe(403);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });

    it('supervised: answers 200, then exits with 75', async () => {
      supervise();
      const codes: number[] = [];
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, oneTab: false, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      const r = await post(s.url, s.url);
      expect(r.status).toBe(200);
      expect(codes).toEqual([]); // the reply came first
      await until(() => codes.length === 1);
      expect(codes).toEqual([75]);
    });
  });

  describe('capabilities (R-M7-15)', () => {
    const bootCaps = async (capabilities: Partial<Capabilities>) => {
      const backend = fakeBackend([{ text: 'hello' }], { capabilities });
      const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false });
      closers.push(s.close);
      return { s, backend };
    };

    it('hello carries the backend capabilities; the fake mirrors Claude by default', async () => {
      const a = await connect((await boot()).url);
      await until(() => a.events.some((e) => e.kind === 'hello'));
      expect(a.events.find((e) => e.kind === 'hello')).toMatchObject({ protocol: PROTOCOL, capabilities: CLAUDE_CAPABILITIES });
      const { s } = await bootCaps({ compact: false, modes: ['default'] });
      const b = await connect(s.url);
      await until(() => b.events.some((e) => e.kind === 'hello'));
      expect(b.events.find((e) => e.kind === 'hello')).toMatchObject({ capabilities: { ...CLAUDE_CAPABILITIES, compact: false, modes: ['default'] } });
    });

    it('refuses a command the agent cannot do, with a server-error naming the capability', async () => {
      const { s } = await bootCaps({ compact: false, clear: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      c.ws.send(JSON.stringify({ type: 'command', name: 'clear' }));
      await until(() => c.events.filter((e) => e.kind === 'server-error' && e.where === 'capability').length === 2);
      expect(c.events.some((e) => e.kind === 'user')).toBe(false);
    });

    it('refuses a mode outside `modes`, but still answers it (the sender waits for its ack)', async () => {
      const { s, backend } = await bootCaps({ modes: ['default'] });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'hi' }));
      await until(() => c.events.some(isResult));
      c.ws.send(JSON.stringify({ type: 'mode', mode: 'plan', id: 'm1' }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
      await until(() => c.events.some((e) => e.kind === 'mode' && e.ack === 'm1'));
      expect(backend.setModes).toEqual([]);
    });

    it('refuses a model message when the agent cannot switch models, but still answers it', async () => {
      const { s, backend } = await bootCaps({ models: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'model', model: 'opus', id: 'x1' }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
      await until(() => c.events.some((e) => e.kind === 'model' && e.ack === 'x1'));
      expect(backend.setModels).toEqual([]);
    });

    it('--fork is dropped when the agent cannot fork, kept when it can', async () => {
      for (const [fork, want] of [[false, undefined], [true, true]] as const) {
        const backend = fakeBackend([{ text: 'x' }], { capabilities: { fork } });
        const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false, resume: 'abc', fork: true });
        closers.push(s.close);
        expect(backend.starts[0]?.fork).toBe(want);
      }
    });

    it('refuses idle-compact when the agent has none', async () => {
      const { s } = await bootCaps({ idleCompact: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'idle-compact', on: false }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
    });
  });
});

describe('server: tracked commands while busy', () => {
  it('a /clear typed during a turn gets send-refused busy on the asking socket; nothing reaches the feed', async () => {
    const backend = fakeBackend([{ text: 'x'.repeat(3000), chunk: 1, delayMs: 5 }]);
    const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist, oneTab: false });
    closers.push(s.close);
    const c = await connect(s.url);
    c.ws.send(JSON.stringify({ type: 'send', id: 'u1', text: 'work' }));
    await until(() => c.events.some((e) => e.kind === 'user'));
    c.ws.send(JSON.stringify({ type: 'send', id: 'c1', text: '/clear' }));
    await until(() => c.events.some((e) => e.kind === 'send-refused'));
    expect(c.events.find((e) => e.kind === 'send-refused')).toEqual({ kind: 'send-refused', id: 'c1', reason: 'busy' });
    expect(c.events.filter((e) => e.kind === 'user')).toHaveLength(1);
    c.ws.send(JSON.stringify({ type: 'interrupt' }));
  });
});
