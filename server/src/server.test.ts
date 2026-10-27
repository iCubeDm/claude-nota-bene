import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLAUDE_CAPABILITIES, PROTOCOL, type Capabilities, type ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
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

async function boot() {
  const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello' }]), webDist: dist });
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
    const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([{ text: 'hello', context: hot }]), webDist: dist });
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
    expect(a.events.find((e) => e.kind === 'hello')).toEqual({ kind: 'hello', protocol: PROTOCOL, capabilities: CLAUDE_CAPABILITIES });
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

  it('an allow that carries a modified input still runs the original input', async () => {
    const seen: unknown[] = [];
    const base = fakeBackend([{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }]);
    // the agent side: what the backend's ask resolves with is what the SDK adapter turns into updatedInput
    const backend = { ...base, start: (o: Parameters<typeof base.start>[0]) => base.start({ ...o, ask: async (...a) => { const r = await o.ask(...a); seen.push(r); return r; } }) };
    const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist });
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

  it('a taken port rejects startServer with the listen error (instead of hanging)', async () => {
    const s = await boot();
    const port = Number(new URL(s.url).port);
    const err = await startServer({ cwd: '/proj', port, backend: fakeBackend([]), webDist: dist }).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err).toMatchObject({ code: 'EADDRINUSE', syscall: 'listen' });
  });

  describe('POST /restart-server', () => {
    afterEach(restoreSup);
    const post = (url: string, origin?: string) =>
      fetch(`${url}/restart-server`, { method: 'POST', ...(origin ? { headers: { origin } } : {}) });

    it('409 when not supervised, and never exits', async () => {
      delete process.env.NOTA_BENE_SUPERVISED;
      const codes: number[] = [];
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, s.url)).status).toBe(409);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });

    it('403 for a foreign Origin (and for none), even when supervised', async () => {
      supervise();
      const codes: number[] = [];
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
      closers.push(s.close);
      expect((await post(s.url, 'http://evil.example')).status).toBe(403);
      expect((await post(s.url)).status).toBe(403);
      await new Promise((r) => setTimeout(r, 250));
      expect(codes).toEqual([]);
    });

    it('supervised: answers 200, then exits with 75', async () => {
      supervise();
      const codes: number[] = [];
      const s = await startServer({ cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist, exit: (c) => { codes.push(c); } });
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
      const s = await startServer({ cwd: '/proj', port: 0, backend, webDist: dist });
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

    it('refuses idle-compact when the agent has none', async () => {
      const { s } = await bootCaps({ idleCompact: false });
      const c = await connect(s.url);
      c.ws.send(JSON.stringify({ type: 'idle-compact', on: false }));
      await until(() => c.events.some((e) => e.kind === 'server-error' && e.where === 'capability'));
    });
  });
});
