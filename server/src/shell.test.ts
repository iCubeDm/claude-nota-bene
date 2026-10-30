import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import type { FakeTurn } from './agent/fake.ts';
import { startServer } from './server.ts';

// `! cmd` over the WebSocket: the one way in (protocol 11)

const SB = '22222222-2222-4222-8222-222222222222';

let tmp: string;
let proj: string;
let other: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-shellws-')));
  proj = path.join(tmp, 'proj');
  other = path.join(tmp, 'other');
  for (const d of ['home', 'dist', 'proj', 'other']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'dist', 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = path.join(tmp, 'home');
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function boot(o: { turns?: FakeTurn[]; oneTab?: boolean; shell?: { timeoutMs?: number; killMs?: number }; historyDelayMs?: number } = {}) {
  const backend = fakeBackend(o.turns ?? [{ text: 'hello' }], {
    historyDelayMs: o.historyDelayMs ?? 0,
    sessions: [{ id: SB, cwd: other, summary: 'B', lastModified: 2, fileSize: 20, history: [{ role: 'user', text: 'before' }] }],
  });
  const s = await startServer({ cwd: proj, port: 0, backend, webDist: path.join(tmp, 'dist'), oneTab: o.oneTab ?? false, takeoverGraceMs: 40, ...(o.shell ? { shell: o.shell } : {}) });
  closers.push(s.close);
  return { ...s, backend };
}

type Client = { ws: WebSocket; events: ServerEvent[]; send(m: unknown): void };
async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(url.replace('http', 'ws'), { headers });
  const events: ServerEvent[] = [];
  ws.on('message', (d) => events.push(JSON.parse(String(d)) as ServerEvent));
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
  closers.push(async () => { ws.terminate(); });
  return { ws, events, send: (m) => ws.send(JSON.stringify(m)) };
}
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Of<K extends ServerEvent['kind']> = Extract<ServerEvent, { kind: K }>;
const ofKind = <K extends ServerEvent['kind']>(c: Client, k: K) => c.events.filter((e): e is Of<K> => e.kind === k);
const endOf = (c: Client, id = 'r1') => ofKind(c, 'shell-end').find((e) => e.id === id);
const refused = (c: Client) => ofKind(c, 'shell-refused');
const isResult = (e: ServerEvent) => e.kind === 'agent' && e.e.t === 'turn-end';

describe('running a command', () => {
  it('shell-run streams a block to the socket: start, output, end with the code', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'echo hello; pwd' });
    await until(() => !!endOf(c));
    const kinds = c.events.map((e) => e.kind).filter((k) => k.startsWith('shell'));
    expect(kinds[0]).toBe('shell-start');
    expect(kinds.at(-1)).toBe('shell-end');
    expect(endOf(c)).toMatchObject({ code: 0, cmd: 'echo hello; pwd', output: `hello\n${proj}\n` });
  });

  it('works while the agent is busy and starts no turn', async () => {
    const s = await boot({ turns: [{ text: 'slow', delayMs: 600 }] });
    const c = await connect(s.url);
    c.send({ type: 'send', id: 'u1', text: 'think' });
    await until(() => c.events.some((e) => e.kind === 'user'));
    expect(((await (await fetch(`${s.url}/info`)).json()) as { busy: boolean }).busy).toBe(true);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'echo during' });
    await until(() => !!endOf(c));
    expect(c.events.some(isResult)).toBe(false); // the turn is still going
    expect(c.events.filter((e) => e.kind === 'user')).toHaveLength(1); // the command is no message
    await until(() => c.events.some(isResult));
  });

  it('a command alone is not a turn: the agent is not busy and nothing reaches it', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'sleep 0.3' });
    await sleep(100);
    expect(((await (await fetch(`${s.url}/info`)).json()) as { busy: boolean }).busy).toBe(false);
    await until(() => !!endOf(c));
    expect(s.backend.prompts).toEqual([]);
  });

  it('refuses a second command while one runs, with a note', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'sleep 30' });
    await until(() => ofKind(c, 'shell-start').length === 1);
    c.send({ type: 'shell-run', id: 'r2', cmd: 'echo second' });
    await until(() => refused(c).length === 1);
    expect(refused(c)[0]).toEqual({ kind: 'shell-refused', id: 'r2', reason: 'running' });
    expect(c.events.filter((e) => e.kind === 'server-error')).toEqual([]); // a refusal is not a toast: the page puts the draft back
    expect(ofKind(c, 'shell-start')).toHaveLength(1);
    c.send({ type: 'shell-stop', id: 'r1' });
    await until(() => !!endOf(c));
  });

  it('shell-stop ends the run with the user as the reason; an unknown id changes nothing', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'echo up; sleep 30' });
    await until(() => ofKind(c, 'shell-out').length > 0);
    c.send({ type: 'shell-stop', id: 'nope' });
    await sleep(80);
    expect(endOf(c)).toBeUndefined();
    c.send({ type: 'shell-stop', id: 'r1' });
    await until(() => !!endOf(c));
    expect(endOf(c)).toMatchObject({ stop: 'user', code: null, output: 'up\n' });
  });

  it('a run past the timeout is stopped with that reason', async () => {
    const s = await boot({ shell: { timeoutMs: 150 } });
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'sleep 30' });
    await until(() => !!endOf(c));
    expect(endOf(c)).toMatchObject({ stop: 'timeout' });
  });

  it('a reload replays the block, and a run in progress brings its output so far', async () => {
    const s = await boot();
    const a = await connect(s.url);
    a.send({ type: 'shell-run', id: 'r1', cmd: 'echo first; sleep 30' });
    await until(() => ofKind(a, 'shell-out').length > 0);
    const b = await connect(s.url);
    await until(() => b.events.some((e) => e.kind === 'hello'));
    const replay = ofKind(b, 'replay')[0]!;
    expect(replay.events.map((e) => e.kind)).toContain('shell-start');
    expect(ofKind(b, 'shell-out')[0]).toEqual({ kind: 'shell-out', id: 'r1', text: 'first\n', truncated: false });
    b.send({ type: 'shell-stop', id: 'r1' });
    await until(() => !!endOf(a));
    const c = await connect(s.url);
    await until(() => c.events.some((e) => e.kind === 'hello'));
    const again = ofKind(c, 'replay')[0]!.events.filter((e) => e.kind.startsWith('shell'));
    expect(again.map((e) => e.kind)).toEqual(['shell-start', 'shell-end']);
    expect(ofKind(c, 'shell-out')).toEqual([]);
  });
});

describe('a flood', () => {
  const rss = () => process.memoryUsage().rss;

  it('a client that reads nothing does not make the server pile up output, and Stop still works for the others', async () => {
    const s = await boot();
    const stalled = await connect(s.url);
    const live = await connect(s.url);
    await until(() => stalled.events.some((e) => e.kind === 'hello') && live.events.some((e) => e.kind === 'hello'));
    (stalled.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // its socket buffer fills, the server's side backs up
    const rss0 = rss();
    live.send({ type: 'shell-run', id: 'r1', cmd: 'yes' });
    await sleep(2500);
    expect(rss() - rss0).toBeLessThan(200 * 1024 * 1024);
    const frames = ofKind(live, 'shell-out');
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.length).toBeLessThan(2500 / 100 + 5);
    const t0 = Date.now();
    live.send({ type: 'shell-stop', id: 'r1' });
    await until(() => !!endOf(live), 4000);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(endOf(live)).toMatchObject({ stop: 'user', truncated: true });
    // the stalled one got far fewer frames than the live one: it was skipped while behind
    const seen = ofKind(stalled, 'shell-out').length;
    expect(seen).toBeLessThan(frames.length);
  }, 20000);
});

describe('/clear', () => {
  it('stops a running command, drops its output and its place in the queue', async () => {
    const s = await boot({ turns: [{ text: 'a' }, { text: 'b' }] });
    const c = await connect(s.url);
    const pidFile = path.join(tmp, 'pid');
    c.send({ type: 'shell-run', id: 'r1', cmd: `echo old-output; sleep 60 & echo $! > ${pidFile}; wait` });
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    c.send({ type: 'command', name: 'clear' });
    await until(() => ofKind(c, 'agent').some((e) => e.e.t === 'reset'));
    await until(() => !alive(pid));
    await sleep(300);
    expect(endOf(c)).toBeUndefined();
    expect(ofKind(c, 'shell-out').filter((e) => e.id === 'r1').length).toBeLessThanOrEqual(1); // none after the reset
    c.send({ type: 'send', id: 'u1', text: 'new conversation' });
    await until(() => s.backend.prompts.includes('new conversation'));
    expect(s.backend.prompts.at(-1)).toBe('new conversation');
    c.send({ type: 'shell-run', id: 'r2', cmd: 'echo fresh' }); // a new run is free to start
    await until(() => !!endOf(c, 'r2'));
  });
});

describe('what the agent hears', () => {
  it('the next message carries the finished runs; the feed shows the message as typed', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'echo hi' });
    await until(() => !!endOf(c));
    c.send({ type: 'send', id: 'u1', text: 'what do you see?' });
    await until(() => c.events.some(isResult));
    expect(s.backend.prompts).toEqual(['<bash-input>echo hi</bash-input>\n<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>\n\nwhat do you see?']);
    expect(ofKind(c, 'user')[0]).toMatchObject({ id: 'u1', text: 'what do you see?' });
    c.send({ type: 'send', id: 'u2', text: 'and now' });
    await until(() => c.events.filter(isResult).length === 2);
    expect(s.backend.prompts[1]).toBe('and now'); // once
  });

  it('a /compact typed in between is sent as itself, and the runs wait for the next message', async () => {
    const s = await boot({ turns: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'echo kept' });
    await until(() => !!endOf(c));
    c.send({ type: 'send', id: 'u1', text: '/compact' });
    await until(() => s.backend.prompts.length === 1);
    expect(s.backend.prompts[0]).toBe('/compact');
    await until(() => c.events.some(isResult));
    c.send({ type: 'send', id: 'u2', text: 'go on' });
    await until(() => s.backend.prompts.length === 2);
    expect(s.backend.prompts[1]).toContain('<bash-input>echo kept</bash-input>');
  });

  it('a session switch stops the run quietly and drops what waited; a restart keeps it', async () => {
    const s = await boot({ turns: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: 'echo queued' });
    await until(() => !!endOf(c));
    c.send({ type: 'restart' });
    await until(() => ofKind(c, 'replay').length >= 2);
    c.send({ type: 'send', id: 'u1', text: 'after restart' });
    await until(() => s.backend.prompts.length === 1);
    expect(s.backend.prompts[0]).toContain('echo queued'); // same session: kept

    c.send({ type: 'shell-run', id: 'r2', cmd: 'echo gone' });
    await until(() => !!endOf(c, 'r2'));
    c.send({ type: 'switch', id: SB, dir: other });
    await until(() => ofKind(c, 'session').some((e) => e.root === other));
    c.send({ type: 'send', id: 'u2', text: 'in B' });
    await until(() => s.backend.prompts.length === 2);
    expect(s.backend.prompts[1]).toBe('in B');
  });

  it('a switch kills a running command and the old block never reaches the new feed', async () => {
    const s = await boot();
    const c = await connect(s.url);
    const pidFile = path.join(tmp, 'pid');
    c.send({ type: 'shell-run', id: 'r1', cmd: `sleep 60 & echo $! > ${pidFile}; wait` });
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    c.send({ type: 'switch', id: SB, dir: other });
    await until(() => ofKind(c, 'session').some((e) => e.root === other));
    await until(() => !alive(pid));
    await sleep(100);
    expect(endOf(c)).toBeUndefined();
    const last = ofKind(c, 'replay').at(-1)!;
    expect(last.events.some((e) => e.kind.startsWith('shell'))).toBe(false);
    c.send({ type: 'shell-run', id: 'r2', cmd: 'pwd' }); // the new session runs in its own root
    await until(() => !!endOf(c, 'r2'));
    expect(endOf(c, 'r2')!.output).toBe(`${other}\n`);
  });

  it('is refused while a switch is in progress', async () => {
    const s = await boot({ historyDelayMs: 400 });
    const c = await connect(s.url);
    c.send({ type: 'switch', id: SB, dir: other });
    await sleep(100);
    c.send({ type: 'shell-run', id: 'r1', cmd: `touch ${path.join(tmp, 'ran')}` });
    await until(() => refused(c).length === 1);
    expect(refused(c)[0]).toMatchObject({ id: 'r1', reason: 'switching' });
    await sleep(300);
    expect(fs.existsSync(path.join(tmp, 'ran'))).toBe(false);
  });
});

describe('the server going away', () => {
  it('close() kills the running command’s whole group', async () => {
    const s = await boot();
    const c = await connect(s.url);
    const pidFile = path.join(tmp, 'pid');
    c.send({ type: 'shell-run', id: 'r1', cmd: `sleep 60 & echo $! > ${pidFile}; wait` });
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    await s.close();
    await until(() => !alive(pid));
  });
});

describe('it adds no way in but the owner’s socket', () => {
  const marker = () => path.join(tmp, 'ran');
  const ran = () => fs.existsSync(marker());

  it('has no HTTP route: a POST finds nothing, a GET gets the page', async () => {
    const s = await boot();
    for (const p of ['/shell', '/shell-run', '/shell/run', '/run', '/exec']) {
      const body = JSON.stringify({ id: 'r1', cmd: `touch ${marker()}` });
      const foreign = await fetch(`${s.url}${p}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } }); // no Origin: refused before any route
      expect(foreign.status).toBe(403);
      const own = await fetch(`${s.url}${p}`, { method: 'POST', body, headers: { 'content-type': 'application/json', origin: s.url } });
      expect([404, 405]).toContain(own.status);
      expect(await (await fetch(`${s.url}${p}?cmd=touch%20${marker()}`)).text()).toBe('<h1>x</h1>'); // the single-page app, as for any unknown path
    }
    await sleep(100);
    expect(ran()).toBe(false);
  });

  it('a socket from a foreign origin is not let in', async () => {
    const s = await boot();
    const ws = new WebSocket(s.url.replace('http', 'ws'), { headers: { Origin: 'https://evil.example' } });
    closers.push(async () => { ws.terminate(); });
    const status = await new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode!));
      ws.once('open', () => { ws.send(JSON.stringify({ type: 'shell-run', id: 'r1', cmd: `touch ${marker()}` })); resolve(0); });
      ws.once('error', () => {});
    });
    expect(status).toBe(403);
    await sleep(150);
    expect(ran()).toBe(false);
  });

  it('a second tab parked behind the overlay can neither run nor stop', async () => {
    const s = await boot({ oneTab: true });
    const owner = await connect(s.url);
    await until(() => owner.events.some((e) => e.kind === 'hello'));
    const parked = await connect(s.url);
    await until(() => parked.events.some((e) => e.kind === 'occupied'));
    parked.send({ type: 'shell-run', id: 'p1', cmd: `touch ${marker()}` });
    await sleep(150);
    expect(ran()).toBe(false);
    expect(ofKind(owner, 'shell-start')).toEqual([]);
    // and it cannot stop the owner's run either
    owner.send({ type: 'shell-run', id: 'r1', cmd: 'sleep 30' });
    await until(() => ofKind(owner, 'shell-start').length === 1);
    parked.send({ type: 'shell-stop', id: 'r1' });
    await sleep(150);
    expect(endOf(owner)).toBeUndefined();
    owner.send({ type: 'shell-stop', id: 'r1' });
    await until(() => !!endOf(owner));
  });

  it('refuses a command over 32 KB, a non-string, an empty one and a bad id, and runs nothing', async () => {
    const s = await boot();
    const c = await connect(s.url);
    const bad: unknown[] = [
      { type: 'shell-run', id: 'r1', cmd: `touch ${marker()}; #${'x'.repeat(32 * 1024)}` },
      { type: 'shell-run', id: 'r1', cmd: 5 },
      { type: 'shell-run', id: 'r1', cmd: ['touch', marker()] },
      { type: 'shell-run', id: 'r1', cmd: '   ' },
      { type: 'shell-run', id: 'r1' },
      { type: 'shell-run', id: 7, cmd: `touch ${marker()}` },
      { type: 'shell-run', id: '../x', cmd: `touch ${marker()}` },
      { type: 'shell-stop', id: 5 },
    ];
    for (const m of bad) c.send(m);
    await until(() => ofKind(c, 'server-error').filter((e) => e.where === 'ws').length === bad.length);
    await sleep(100);
    expect(ran()).toBe(false);
    expect(ofKind(c, 'shell-start')).toEqual([]);
    c.send({ type: 'shell-run', id: 'ok', cmd: 'echo still works' }); // the socket and the server are fine
    await until(() => !!endOf(c, 'ok'));
  });

  it('takes the command as one argv item: the shell sees exactly the text', async () => {
    const s = await boot();
    const c = await connect(s.url);
    c.send({ type: 'shell-run', id: 'r1', cmd: `printf '%s' "a b" '$HOME' ; echo` });
    await until(() => !!endOf(c));
    expect(endOf(c)!.output).toBe('a b$HOME\n');
  });
});

describe('signals that end the server', () => {
  const MAIN = new URL('./main.ts', import.meta.url).pathname;
  const FAKE = new URL('../test/fixtures/hello.json', import.meta.url).pathname;
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGINT'] as const) {
    it(`${sig} stops a running command's whole group, and the server exits`, async () => {
      const child = spawn(process.execPath, [MAIN, proj, '--port', '0', '--fake', FAKE], { env: { ...process.env, NOTA_BENE_HOME: path.join(tmp, 'home') }, stdio: ['ignore', 'pipe', 'inherit'] });
      closers.push(async () => { child.kill('SIGKILL'); });
      let out = '';
      child.stdout!.on('data', (d) => { out += String(d); });
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      await until(() => /Nota Bene: http:\/\/127\.0\.0\.1:\d+/.test(out));
      const url = /Nota Bene: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)![1]!;
      const c = await connect(url);
      const pidFile = path.join(tmp, `pid-${sig}`);
      c.send({ type: 'shell-run', id: 'r1', cmd: `sleep 60 & echo $! > ${pidFile}; wait` });
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(alive(pid)).toBe(true);
      child.kill(sig);
      await exited;
      await until(() => !alive(pid), 3000);
    }, 15000);
  }
});
