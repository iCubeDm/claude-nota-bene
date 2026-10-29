import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES, type AgentEvent, type ServerEvent } from '@nota-bene/shared';
import { mapFrames } from './agent/claude/map.ts';
import { fakeBackend } from './agent/fake.ts';
import type { FakeTurn } from './agent/fake.ts';
import type { AgentBackend, PermissionAsk } from './agent/types.ts';
import { EventHub } from './hub.ts';
import { createSessionManager } from './session.ts';
import { lastSession } from './state.ts';
import { prefsKey, readPrefs, setModePref } from './prefs.ts';
import { AttachmentStore } from './attachments.ts';

let home: string;
const extraDirs: string[] = []; // project folders a test makes besides `home`, removed even when the test fails
const mkExtra = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  extraDirs.push(d);
  return d;
};
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-session-')); process.env.NOTA_BENE_HOME = home; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  for (const d of [home, ...extraDirs.splice(0)]) fs.rmSync(d, { recursive: true, force: true });
});

function setup(backend: AgentBackend) {
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind !== 'replay') events.push(e); } });
  return { hub, events, make: () => createSessionManager({ hub, backend, cwd: '/proj' }) };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const noSessions = { capabilities: CLAUDE_CAPABILITIES, listSessions: async () => [], sessionInfo: async () => null, subagent: async () => null };

type Agent = Extract<ServerEvent, { kind: 'agent' }>;
const agentOf = (events: ServerEvent[], t: Agent['e']['t']) => events.filter((e): e is Agent => e.kind === 'agent' && e.e.t === t);

describe('session manager', () => {
  it('no base64 of a tool_result image reaches the hub: the tool-update carries [image]', async () => {
    const frame = (type: string, content: unknown[]) => ({ type, message: { content } });
    const img = { type: 'image', source: { type: 'base64', data: 'AAAA' } };
    const frames = [
      frame('user', [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'hi' }, img] }]),
      frame('assistant', [img]),
      { type: 'result', subtype: 'success' },
    ];
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => ({
        messages: mapFrames((async function* () { yield* frames as never[]; await new Promise(() => {}); })()),
        send() {}, interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
      }),
    };
    const { events, make } = setup(backend);
    await make();
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(agentOf(events, 'tool-update')).toMatchObject([{ e: { t: 'tool-update', id: 't', text: 'hi\n[image]', isError: false } }]);
    // an assistant image block maps to no event at all (the feed never showed one)
    expect(JSON.stringify(events)).not.toContain('AAAA');
  });

  it('fileSuggestions delegates to the agent and rejects once it has died', async () => {
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => ({
        messages: mapFrames((async function* () { await new Promise((r) => setTimeout(r, 30)); throw new Error('boom'); yield* []; })()),
        send() {}, interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async (q) => [`hit-${q}`], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
      }),
    };
    const { events, make } = setup(backend);
    const s = await make();
    expect(await s.fileSuggestions('a')).toEqual(['hit-a']);
    await until(() => agentOf(events, 'turn-end').length === 1); // the crash became an error result; the agent is gone
    await expect(s.fileSuggestions('a')).rejects.toThrow('no agent');
  });

  it('send emits user then the agent reply', async () => {
    const { events, make } = setup(fakeBackend([{ text: 'hello' }]));
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('user')).toBeGreaterThanOrEqual(0);
    const a = events.findIndex((e) => e.kind === 'agent' && e.e.t === 'message');
    expect(kinds.indexOf('user')).toBeLessThan(a);
  });

  it('permission round-trip', async () => {
    const turns: FakeTurn[] = [{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }];
    const { events, make } = setup(fakeBackend(turns));
    const s = await make();
    s.send({ id: 'u1', text: 'run' });
    await until(() => events.some((e) => e.kind === 'permission'));
    const p = events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    expect(p.toolName).toBe('Bash');
    expect(agentOf(events, 'turn-end')).toHaveLength(0);
    s.answer('unknown-id', true); // no-op
    s.answer(p.id, true);
    await until(() => agentOf(events, 'turn-end').length === 1);
    const done = events.find((e) => e.kind === 'permission-done');
    expect(done).toMatchObject({ kind: 'permission-done', id: p.id, allow: true });
  });

  it('pending permission is denied when the turn is interrupted', async () => {
    const { events, make } = setup(fakeBackend([{ text: 'ok', ask: { toolName: 'Bash', input: {} } }]));
    const s = await make();
    s.send({ id: 'u1', text: 'run' });
    await until(() => events.some((e) => e.kind === 'permission'));
    s.interrupt();
    await until(() => events.some((e) => e.kind === 'permission-done'));
    expect(events.find((e) => e.kind === 'permission-done')).toMatchObject({ allow: false });
  });

  it('saves the session id on init', async () => {
    const { events, make } = setup(fakeBackend([{ text: 'a' }]));
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'session' && e.id !== null));
    expect(lastSession('/proj')).toBe('fake-session');
    expect(s.info()).toEqual({ id: 'fake-session', root: '/proj', title: null, model: null });
  });

  it('capabilities: usage:false never asks the agent for usage; fileSuggestions:false answers [] without asking', async () => {
    const calls: string[] = [];
    const inner = fakeBackend([{ text: 'a', context: { used: 5, max: 10, pct: 50 } }]);
    const backend: AgentBackend = {
      ...inner,
      capabilities: { ...CLAUDE_CAPABILITIES, usage: false, fileSuggestions: false },
      start: (o) => {
        const a = inner.start(o);
        return {
          messages: a.messages, send: (m) => a.send(m), interrupt: () => a.interrupt(), setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {},
          fileSuggestions: async () => { calls.push('files'); return ['x']; },
          contextUsage: async () => { calls.push('context'); return { used: 1, max: 2, pct: 50 }; },
          usage: async () => { calls.push('usage'); return { cost: null, limits: null }; }, close: () => a.close(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(await s.fileSuggestions('x')).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
    expect(events.some((e) => e.kind === 'stats')).toBe(false);
  });

  it('crash surfaces an error and recovers', async () => {
    const crash = fakeBackend([{ text: 'boom!', crash: true }]);
    const ok = fakeBackend([{ text: 'fine' }]);
    const resumes: (string | undefined)[] = [];
    let n = 0;
    const backend: AgentBackend = {
      ...noSessions,
      history: ok.history,
      start: (o) => { resumes.push(o.resume); return (n++ === 0 ? crash : ok).start(o); },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'server-error'));
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(agentOf(events, 'turn-end')[0]!.e).toEqual({ t: 'turn-end', stop: 'failed', secs: 0, error: 'fake backend crash', answers: ['u1'], queued: 0 });
    s.send({ id: 'u2', text: 'again' });
    await until(() => agentOf(events, 'turn-end').length === 2);
    expect(resumes).toEqual([undefined, 'fake-session']);
    expect(agentOf(events, 'message').at(-1)!.e).toMatchObject({ text: 'fine' });
  });

  it('every force send interrupts first, even after an earlier force', async () => {
    const log: string[] = [];
    const inner = fakeBackend([{ text: 'x'.repeat(300), chunk: 1, delayMs: 5 }]);
    const backend: AgentBackend = {
      ...noSessions,
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return {
          messages: a.messages,
          send: (m) => { log.push(`send:${m.priority}`); a.send(m); },
          interrupt: () => { log.push('interrupt'); return a.interrupt(); },
          setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => a.close(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u0', text: 'idle force', force: true }); // idle: must not throw
    s.send({ id: 'a', text: 'A' });
    await until(() => agentOf(events, 'message-chunk').length > 2);
    s.send({ id: 'b', text: 'B', force: true });
    s.send({ id: 'c', text: 'C', force: true });
    await until(() => log.length >= 7);
    expect(log).toEqual(['interrupt', 'send:now', 'send:next', 'interrupt', 'send:now', 'interrupt', 'send:now']);
  });

  it('a clean end of the agent session is reported and the next send restarts', async () => {
    const first = fakeBackend([{ text: 'one' }]);
    const second = fakeBackend([{ text: 'two' }]);
    const resumes: (string | undefined)[] = [];
    let n = 0;
    const backend: AgentBackend = {
      ...noSessions,
      history: first.history,
      start: (o) => {
        resumes.push(o.resume);
        const a = (n++ === 0 ? first : second).start(o);
        if (n > 1) return a;
        return {
          ...a,
          send: (m) => a.send(m),
          interrupt: () => a.interrupt(),
          setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => a.close(),
          messages: (async function* () {
            for await (const e of a.messages) {
              yield e;
              if (e.t === 'turn-end') return;
            }
          })(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'server-error'));
    await until(() => agentOf(events, 'turn-end').length === 2);
    expect(s.busy()).toBe(false);
    s.send({ id: 'u2', text: 'again' });
    await until(() => agentOf(events, 'turn-end').length === 3);
    expect(resumes).toEqual([undefined, 'fake-session']);
    expect(agentOf(events, 'turn-end')[1]).toMatchObject({ e: { stop: 'failed', error: 'agent session ended', answers: [] } }); // u1 was answered already: nothing left running
  });

  it('crash with a pending permission denies it and closes the agent', async () => {
    let closed = 0;
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: (o) => ({
        messages: mapFrames((async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's1' } as never;
          void o.ask('Bash', {}, new AbortController().signal);
          await new Promise((r) => setTimeout(r, 20));
          throw new Error('dead');
        })()),
        send: () => {},
        interrupt: async () => {},
        setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => { closed++; },
      }),
    };
    const { events, make } = setup(backend);
    await make();
    await until(() => events.some((e) => e.kind === 'permission-done'));
    expect(events.find((e) => e.kind === 'permission-done')).toMatchObject({ allow: false });
    expect(closed).toBe(1);
  });

  it('a throwing agent.send is reported and the next send still goes through', async () => {
    const inner = fakeBackend([{ text: 'fine' }]);
    let first = true;
    const backend: AgentBackend = {
      ...noSessions,
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return {
          messages: a.messages,
          send: (m) => { if (first) { first = false; throw new Error('send failed'); } a.send(m); },
          interrupt: () => a.interrupt(),
          setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => a.close(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'lost' });
    await until(() => events.some((e) => e.kind === 'server-error' && e.where === 'send'));
    s.send({ id: 'u2', text: 'ok' });
    await until(() => agentOf(events, 'turn-end').length === 1);
  });

  it('a send queued across a crash is delivered to the fresh agent', async () => {
    const resumes: (string | undefined)[] = [];
    const delivered: string[] = [];
    let n = 0;
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: (o) => {
        resumes.push(o.resume);
        const mine = n++;
        return {
          messages: mapFrames((async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as never;
            if (mine === 0) { await new Promise((r) => setTimeout(r, 10)); throw new Error('dead'); }
            await new Promise(() => {});
          })()),
          send: (m) => { delivered.push(`${mine}:${m.text}`); },
          interrupt: () => new Promise<void>((r) => setTimeout(r, 40)),
          setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => {},
        };
      },
    };
    const { make } = setup(backend);
    const s = await make();
    await new Promise((r) => setTimeout(r, 2));
    s.send({ id: 'u1', text: 'queued', force: true });
    await until(() => delivered.length === 1);
    expect(delivered).toEqual(['1:queued']);
    expect(resumes).toEqual([undefined, 'fake-session']);
  });

  it('M7-18: a crash fails the send the dead agent had, not the one still queued behind a forced interrupt', async () => {
    const delivered: string[] = [];
    let n = 0;
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => {
        const mine = n++;
        return {
          messages: mapFrames((async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as never;
            if (mine === 0) { await new Promise((r) => setTimeout(r, 10)); throw new Error('dead'); }
            await new Promise(() => {});
          })()),
          send: (m) => { delivered.push(`${mine}:${m.uuid}`); },
          interrupt: () => new Promise<void>((r) => setTimeout(r, 40)),
          setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => {},
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'A', text: 'running' });
    s.send({ id: 'B', text: 'queued', force: true }); // waits in the SendQueue for the interrupt
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(agentOf(events, 'turn-end')[0]!.e).toMatchObject({ stop: 'failed', error: 'dead', answers: ['A'] });
    expect(s.busy()).toBe(true); // B is still waiting
    await until(() => delivered.length === 2);
    expect(delivered).toEqual(['0:A', '1:B']);
    expect(s.busy()).toBe(true); // until B's own turn-end
  });

  it('a failing transcript read on resume is reported and starts with empty history', async () => {
    const inner = fakeBackend([{ text: 'fine' }]);
    const backend: AgentBackend = {
      ...noSessions, start: inner.start, history: async () => { throw new Error('transcript gone'); } };
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', resume: 'old' });
    expect(events.find((e) => e.kind === 'server-error')).toMatchObject({ where: 'history', message: 'transcript gone' });
    const replayed: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') replayed.push(...e.events); } });
    expect(replayed.some((e) => e.kind === 'user' || e.kind === 'agent')).toBe(false);
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
  });

  it('resume: history, then exactly one resumed marker, then live events; one session per distinct id', async () => {
    const inner = fakeBackend([{ text: 'a' }]);
    const old: ServerEvent[] = [{ kind: 'user', id: 'h1', text: 'before', ts: 1, historic: true }];
    const backend: AgentBackend = {
      ...noSessions, start: inner.start, history: async () => old };
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', resume: 'old-session' });
    const replayed: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') replayed.push(...e.events); } });
    expect(replayed.map((e) => e.kind)).toEqual(['user', 'resumed', 'session']);
    expect(replayed[1]).toEqual({ kind: 'resumed', id: 'old-session' });
    expect(replayed[2]).toEqual({ kind: 'session', id: 'old-session', root: '/proj', title: null, model: null });
    s.send({ id: 'u1', text: 'one' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    s.send({ id: 'u2', text: 'two' });
    await until(() => agentOf(events, 'turn-end').length === 2);
    // the CLI sends init at the start of every turn; it is server-internal (R-M7-14), never sent to the clients
    expect(events.some((e) => e.kind === 'agent' && (e.e as AgentEvent).t === 'init')).toBe(false);
    expect(events.filter((e) => e.kind === 'resumed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'session')).toHaveLength(1); // same id: no new session event
    expect(lastSession('/proj')).toBe('old-session');
  });

  it('fresh start: a session event with null id, then one more when the first init names the id', async () => {
    const { events, make } = setup(fakeBackend([{ text: 'a' }]));
    const s = await make();
    s.send({ id: 'u1', text: 'one' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    s.send({ id: 'u2', text: 'two' });
    await until(() => agentOf(events, 'turn-end').length === 2);
    expect(events.filter((e) => e.kind === 'session').map((e) => (e as { id: string | null }).id)).toEqual([null, 'fake-session']);
    expect(events.some((e) => e.kind === 'resumed')).toBe(false);
  });
});

// the web reducer decides what the user sees; loaded by variable path so the server project does not compile web sources
async function feedOf(events: ServerEvent[]): Promise<{ busy: boolean; waiting: string[] }> {
  const href = new URL('../../web/src/store/feed.ts', import.meta.url).href;
  const { reduce, emptyFeed } = (await import(/* @vite-ignore */ href)) as { reduce: (s: unknown, e: ServerEvent) => never; emptyFeed: unknown };
  return events.reduce(reduce as never, emptyFeed as never) as never;
}

describe('busy cannot get stuck', () => {
  it('a failed agent.send answers the send with a stored error result', async () => {
    const inner = fakeBackend([{ text: 'x' }]);
    const backend: AgentBackend = {
      ...noSessions,
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return { messages: a.messages, send: () => { throw new Error('stdin closed'); }, interrupt: () => a.interrupt(), setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => a.close() };
      },
    };
    const { hub, events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('server-error')).toBeLessThan(events.findIndex((e) => e.kind === 'agent' && e.e.t === 'turn-end'));
    expect(agentOf(events, 'turn-end')[0]!.e).toEqual({ t: 'turn-end', stop: 'failed', secs: 0, error: 'stdin closed', answers: ['u1'], queued: 0 });
    const attached: ServerEvent[] = [];
    hub.attach({ send: (d) => attached.push(...(JSON.parse(d) as { events: ServerEvent[] }).events) });
    const f = await feedOf(attached);
    expect(f.waiting).toEqual([]);
    expect(f.busy).toBe(false);
    expect(s.busy()).toBe(false);
  });

  it('M7-18: a send kept queued across a crash is answered by its own turn-end on the new agent: busy ends, the feed too', async () => {
    let n = 0;
    let answer!: (uuid: string) => void;
    const answered = new Promise<string>((r) => { answer = r; });
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => {
        const mine = n++;
        return {
          messages: mapFrames((async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as never;
            if (mine === 0) { await new Promise((r) => setTimeout(r, 10)); throw new Error('dead'); }
            const uuid = await answered;
            yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, terminal_reason: 'completed', user_message_uuids: [uuid] } as never;
            await new Promise(() => {});
          })()),
          send: (m) => { if (mine === 1) answer(m.uuid); },
          interrupt: () => new Promise<void>((r) => setTimeout(r, 40)),
          setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => {},
        };
      },
    };
    const { hub, events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'A', text: 'running' });
    s.send({ id: 'B', text: 'queued', force: true });
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(agentOf(events, 'turn-end')[0]!.e).toMatchObject({ stop: 'failed', answers: ['A'] });
    const feedNow = async () => {
      const attached: ServerEvent[] = [];
      hub.attach({ send: (d) => attached.push(...(JSON.parse(d) as { events: ServerEvent[] }).events) });
      return feedOf(attached);
    };
    const afterCrash = await feedNow();
    expect(afterCrash.waiting).toEqual(['B']);
    expect(afterCrash.busy).toBe(true);
    expect(s.busy()).toBe(true);
    await until(() => agentOf(events, 'turn-end').length === 2);
    expect(agentOf(events, 'turn-end')[1]!.e).toMatchObject({ stop: 'done', answers: ['B'] });
    expect(s.busy()).toBe(false);
    const done = await feedNow();
    expect(done.waiting).toEqual([]);
    expect(done.busy).toBe(false);
    s.close();
  });

  it('a crash with sends handed to the dead agent leaves busy false', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sent = 0;
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => ({
        messages: mapFrames((async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as never;
          await gate;
          throw new Error('dead');
        })()),
        send: () => { sent++; },
        interrupt: async () => {},
        setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close: () => {},
      }),
    };
    const { hub, events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'A', text: 'one' });
    s.send({ id: 'B', text: 'two' });
    await until(() => sent === 2);
    release();
    await until(() => agentOf(events, 'turn-end').length === 1);
    const attached: ServerEvent[] = [];
    hub.attach({ send: (d) => attached.push(...(JSON.parse(d) as { events: ServerEvent[] }).events) });
    expect(agentOf(events, 'turn-end')[0]!.e).toMatchObject({ stop: 'failed', error: 'dead', answers: ['A', 'B'] }); // both were handed to the dead agent
    const f = await feedOf(attached);
    expect(f.waiting).toEqual([]);
    expect(f.busy).toBe(false);
    expect(s.busy()).toBe(false);
  });

  describe('image attachments', () => {
    const png = (n: string) => Buffer.from(`png-${n}`);

    it('a send with two refs reaches the agent as images and the hub event carries refs only', async () => {
      const attachments = new AttachmentStore({ dir: path.join(home, 'att') });
      const refs = ['a', 'b'].map((n, i) => ({ id: attachments.put(png(n), 'image/png'), mediaType: 'image/png' as const, label: `Comment ${i + 1}` }));
      const got: unknown[] = [];
      const backend: AgentBackend = {
      ...noSessions,
        history: async () => [],
        start: () => ({
          messages: mapFrames((async function* () { await new Promise(() => {}); })()),
          send: (m) => { got.push(m); }, interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
        }),
      };
      const hub = new EventHub();
      const events: ServerEvent[] = [];
      hub.attach({ send: (d) => events.push(JSON.parse(d) as ServerEvent) });
      const s = await createSessionManager({ hub, backend, cwd: '/proj', attachments });
      s.send({ id: 'u1', text: 'see', images: refs });
      await until(() => got.length === 1);
      expect(got[0]).toMatchObject({
        text: 'see',
        images: [
          { mediaType: 'image/png', data: png('a').toString('base64'), label: 'Comment 1' },
          { mediaType: 'image/png', data: png('b').toString('base64'), label: 'Comment 2' },
        ],
      });
      const user = events.find((e) => e.kind === 'user');
      expect(user).toMatchObject({ images: refs });
      expect(JSON.stringify(events)).not.toContain(png('a').toString('base64'));
    });

    it('an unknown ref id is reported as attach; the text and the other images still go out', async () => {
      const attachments = new AttachmentStore({ dir: path.join(home, 'att') });
      const ok = { id: attachments.put(png('a'), 'image/png'), mediaType: 'image/png' as const, label: 'ok' };
      const bad = { id: 'f'.repeat(64), mediaType: 'image/png' as const, label: 'bad' };
      const got: { text: string; images?: unknown[] }[] = [];
      const backend: AgentBackend = {
      ...noSessions,
        history: async () => [],
        start: () => ({
          messages: mapFrames((async function* () { await new Promise(() => {}); })()),
          send: (m) => { got.push(m); }, interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
        }),
      };
      const hub = new EventHub();
      const events: ServerEvent[] = [];
      hub.attach({ send: (d) => events.push(JSON.parse(d) as ServerEvent) });
      const s = await createSessionManager({ hub, backend, cwd: '/proj', attachments });
      s.send({ id: 'u1', text: 'hello', images: [bad, ok] });
      await until(() => got.length === 1);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'server-error', where: 'attach' }));
      expect(got[0]!.text).toBe('hello');
      expect(got[0]!.images).toHaveLength(1);
    });
  });
});

describe('compact-end and idle compaction', () => {
  const idle = { afterMs: 60, awayMs: 0, retryMs: 30, cacheMs: 2000, minTokens: 100 };
  // an agent whose frames the test pushes; a big context, so an armed compactor fires
  function pushed() {
    const sends: { uuid: string; text: string }[] = [];
    let push: (f: object) => void = () => {};
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => {
        const q: object[] = [];
        let wake: (() => void) | null = null;
        push = (f) => { q.push(f); wake?.(); };
        return {
          messages: mapFrames((async function* () {
            while (true) {
              while (q.length) yield q.shift() as never;
              await new Promise<void>((r) => { wake = r; });
            }
          })()),
          send: (m) => { sends.push({ uuid: m.uuid, text: m.text }); },
          interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [],
          contextUsage: async () => ({ used: 500_000, max: 1_000_000, pct: 50 }), usage: async () => ({ cost: null, limits: null }), close() {},
        };
      },
    };
    return { backend, sends, push: (f: object) => push(f) };
  }
  const result = (uuids: string[]) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, terminal_reason: 'completed', user_message_uuids: uuids });
  const bareNull = { type: 'system', subtype: 'status', status: null }; // -> compact-end
  const idleSends = (sends: { text: string }[]) => sends.filter((x) => x.text === '/compact');

  it('compact-end does not arm it: after a command\'s turn-end (which never arms) it stays quiet', async () => {
    const { backend, sends, push } = pushed();
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', idle, idleOffInSettings: () => false });
    s.command('compact');
    await until(() => sends.length === 1);
    push(result([sends[0]!.uuid])); // the command's own turn-end: refreshes the context, does not arm
    push(bareNull);
    await until(() => agentOf(events, 'compact-end').length === 1);
    await new Promise((r) => setTimeout(r, idle.afterMs * 4));
    expect(idleSends(sends)).toHaveLength(1); // only the manual /compact
    s.close();
  });

  it('compact-end does not disarm it: a turn-end armed it, a bare status null after it changes nothing', async () => {
    const { backend, sends, push } = pushed();
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', idle, idleOffInSettings: () => false });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => sends.length === 1);
    push(result(['u1']));
    push(bareNull);
    await until(() => agentOf(events, 'compact-end').length === 1);
    await until(() => idleSends(sends).length === 1);
    expect(events.find((e) => e.kind === 'user' && e.idle)).toMatchObject({ text: '/compact' });
    s.close();
  });
});

describe('permission mode', () => {
  it('capabilities: the agent starts in a mode it offers (a persisted \'auto\' becomes the first of `modes`); the pref stays', async () => {
    setModePref('/proj', 'auto');
    const inner = fakeBackend([{ text: 'a' }], { capabilities: { modes: ['default'] } });
    const { hub, events } = setup(inner);
    const s = await createSessionManager({ hub, backend: inner, cwd: '/proj' });
    expect(inner.startModes).toEqual(['default']);
    expect(s.mode()).toBe('default');
    expect(readPrefs().modes[prefsKey('/proj')]).toBe('auto');
    void events;
    s.close();
  });

  const modeEvents = (events: ServerEvent[]) => events.filter((e) => e.kind === 'mode').map((e) => (e as { mode: string }).mode);

  it('starts in the mode saved for the project, auto otherwise', async () => {
    const b1 = fakeBackend([{ text: 'x' }]);
    expect((await setup(b1).make()).mode()).toBe('auto');
    expect(b1.startModes).toEqual(['auto']);
    setModePref('/proj', 'plan');
    const b2 = fakeBackend([{ text: 'x' }]);
    expect((await setup(b2).make()).mode()).toBe('plan');
    expect(b2.startModes).toEqual(['plan']);
  });

  it('setMode calls the agent, persists and emits once', async () => {
    const b = fakeBackend([{ text: 'x' }]);
    const { events, make } = setup(b);
    const s = await make();
    await s.setMode('acceptEdits');
    expect(b.setModes).toEqual(['acceptEdits']);
    expect(s.mode()).toBe('acceptEdits');
    expect(readPrefs().modes[prefsKey('/proj')]).toBe('acceptEdits');
    expect(modeEvents(events)).toEqual(['acceptEdits']);
  });

  it('an SDK rejection reports and re-emits the old mode', async () => {
    const inner = fakeBackend([{ text: 'x' }]);
    const backend: AgentBackend = {
      ...noSessions,
      history: inner.history,
      start: (o) => ({ ...inner.start(o), setPermissionMode: async () => { throw new Error('nope'); } }),
    };
    const { events, make } = setup(backend);
    const s = await make();
    await s.setMode('plan');
    expect(s.mode()).toBe('auto');
    expect(readPrefs().modes).toEqual({});
    expect(modeEvents(events)).toEqual(['auto']);
    expect(events).toContainEqual({ kind: 'server-error', where: 'mode', message: 'nope' });
  });

  it('with no agent, setMode still persists and emits, and the next agent starts in it', async () => {
    const inner = fakeBackend([{ text: 'x', crash: true }, { text: 'y' }]);
    const { events, make } = setup(inner);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1); // the crash killed the agent
    await s.setMode('default');
    expect(inner.setModes).toEqual([]);
    expect(modeEvents(events)).toEqual(['default']);
    s.send({ id: 'u2', text: 'again' });
    expect(inner.startModes).toEqual(['auto', 'default']);
  });

  it('follows an init whose permissionMode differs', async () => {
    setModePref('/proj', 'plan');
    const { events, make } = setup(fakeBackend([{ text: 'x', initMode: 'default' }]));
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(s.mode()).toBe('default');
    expect(readPrefs().modes[prefsKey('/proj')]).toBe('default');
    expect(modeEvents(events)).toEqual(['default']);
  });

  it('follows a status message too', async () => {
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: () => ({
        messages: mapFrames((async function* () { yield { type: 'system', subtype: 'status', permissionMode: 'acceptEdits' } as never; await new Promise(() => {}); })()),
        send() {}, interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
      }),
    };
    const { events, make } = setup(backend);
    const s = await make();
    await until(() => modeEvents(events).length === 1);
    expect(s.mode()).toBe('acceptEdits');
  });

  // an agent whose frames the test pushes by hand; setPermissionMode runs `onSet` before it resolves
  function manual(onSet: (push: (f: object) => void) => Promise<void>): AgentBackend {
    return {
      ...noSessions,
      history: async () => [],
      start: () => {
        const q: object[] = [];
        let wake: (() => void) | null = null;
        const push = (f: object) => { q.push(f); wake?.(); };
        return {
          messages: mapFrames((async function* () {
            while (true) {
              while (q.length) yield q.shift() as never;
              await new Promise<void>((r) => { wake = r; });
            }
          })()),
          send() {}, interrupt: async () => {}, fileSuggestions: async () => [], contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }), close() {},
          setPermissionMode: () => onSet(push), supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {},
        };
      },
    };
  }
  const status = (permissionMode: string) => ({ type: 'system', subtype: 'status', permissionMode });

  it('a status frame that beats the control response: the CLI\'s emit, then the answer with the ack', async () => {
    const { events, make } = setup(manual(async (push) => { push(status('plan')); await new Promise((r) => setTimeout(r, 20)); }));
    const s = await make();
    await s.setMode('plan', 'm1');
    expect(events.filter((e) => e.kind === 'mode')).toEqual([{ kind: 'mode', mode: 'plan' }, { kind: 'mode', mode: 'plan', ack: 'm1' }]);
    expect(readPrefs().modes[prefsKey('/proj')]).toBe('plan');
  });

  it('every mode request is answered once with its ack, a refused one too', async () => {
    const { events, make } = setup(manual(async () => { throw new Error('nope'); }));
    const s = await make();
    await s.setMode('plan', 'm2');
    expect(events.filter((e) => e.kind === 'mode').at(-1)).toEqual({ kind: 'mode', mode: 'auto', ack: 'm2' });
  });

  it('the echo of our own change (same mode in a later status) gives one emit', async () => {
    let push: (f: object) => void = () => {};
    const { events, make } = setup(manual(async (p) => { push = p; }));
    const s = await make();
    await s.setMode('plan');
    push(status('plan'));
    await new Promise((r) => setTimeout(r, 20));
    expect(modeEvents(events)).toEqual(['plan']);
  });
});

describe('switch', () => {
  const stubs = {
    send() {}, interrupt: async () => {}, setPermissionMode: async () => {}, supportedModels: async () => [], setModel: async () => {}, setEffort: async () => {}, fileSuggestions: async () => [],
    contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }),
  };

  it('a late message from the old agent after the reset is not emitted', async () => {
    const dirB = fs.realpathSync(mkExtra('nb-switch-b-'));
    let release!: () => void;
    const late = new Promise<void>((r) => { release = r; });
    let oldAsk: PermissionAsk | null = null;
    let n = 0;
    const fresh = fakeBackend([{ text: 'new' }]);
    const backend: AgentBackend = {
      ...noSessions,
      listSessions: async () => [{ sessionId: 'b', lastModified: 0, cwd: dirB }], // a new session may open in B
      history: async () => [],
      start: (o) => {
        if (++n > 1) return fresh.start(o);
        oldAsk = o.ask;
        return {
          ...stubs,
          // ignores close(): the loop never ends, and it speaks again after the switch
          messages: mapFrames((async function* () {
            await late;
            yield { type: 'assistant', uuid: 'late-from-old', message: { content: [{ type: 'text', text: 'late' }] } } as never;
            yield { type: 'system', subtype: 'init', session_id: 'old-late', permissionMode: 'plan' } as never;
            await new Promise(() => {});
          })()),
          close() {},
        };
      },
    };
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', closeTimeoutMs: 20 });
    await s.switch({ id: null, dir: dirB });
    expect(s.info().root).toBe(dirB);
    const mark = events.length;
    release();
    // the old agent also asks for a permission after the reset: denied, never shown
    const allowed = await oldAsk!('Bash', {}, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 30));
    expect(allowed).toBe(false);
    const after = events.slice(mark);
    expect(JSON.stringify(after)).not.toContain('late-from-old');
    expect(after.filter((e) => e.kind === 'session' || e.kind === 'mode' || e.kind === 'permission')).toEqual([]);
    expect(s.info()).toMatchObject({ id: null, root: dirB });
    expect(s.mode()).toBe('auto');
    s.close();
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('a busy restart: a forced send stuck in its interrupt neither reaches the new agent nor toasts', async () => {
    const dirA = fs.realpathSync.native(mkExtra('nb-restart-'));
    const log: string[] = [];
    const sent: string[][] = [];
    const inner = fakeBackend([{ text: 'x'.repeat(2000), chunk: 1, delayMs: 5 }]);
    const backend: AgentBackend = {
      ...noSessions,
      history: async () => [],
      start: (o) => {
        const a = inner.start(o);
        const mine: string[] = [];
        sent.push(mine);
        log.push(`start${sent.length}`);
        let closed!: () => void;
        const onClose = new Promise<void>((r) => { closed = r; });
        return {
          ...a,
          messages: a.messages,
          send: (m) => { mine.push(m.uuid); a.send(m); },
          // like the SDK: an interrupt that hangs and is rejected when the query closes
          interrupt: () => onClose.then(() => { throw new Error('Query closed'); }),
          setPermissionMode: (m) => a.setPermissionMode(m), supportedModels: () => a.supportedModels(), setModel: (m) => a.setModel(m), setEffort: (e) => a.setEffort(e), fileSuggestions: (q) => a.fileSuggestions(q),
          contextUsage: () => a.contextUsage(), usage: () => a.usage(),
          close: () => { closed(); a.close(); },
        };
      },
    };
    const hub = new EventHub();
    const events: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') log.push('replay'); events.push(e); } });
    const s = await createSessionManager({ hub, backend, cwd: dirA, closeTimeoutMs: 50, interruptTimeoutMs: 50 });
    s.send({ id: 'u1', text: 'long' });
    await until(() => agentOf(events, 'message-chunk').length > 2);
    s.send({ id: 'u2', text: 'now', force: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.busy()).toBe(true);
    await s.restart();
    await new Promise((r) => setTimeout(r, 50));
    expect(log.slice(log.indexOf('start1') + 1)).toEqual(['replay', 'replay', 'start2']); // agent2 after the replay
    expect(sent[1]).toEqual([]);
    expect(events.filter((e) => e.kind === 'server-error')).toEqual([]);
    expect(s.busy()).toBe(false);
    const mark = events.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.slice(mark).filter((e) => e.kind === 'agent')).toEqual([]); // agent2 is idle
    s.close();
    fs.rmSync(dirA, { recursive: true, force: true });
  });

  it('the result a real /clear sends is live only: a reload never shows it; the next turn\'s result is stored', async () => {
    const backend = fakeBackend([{ text: 'x' }]);
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    s.command('clear');
    await until(() => agentOf(events, 'turn-end').length === 1);
    await until(() => !s.busy());
    const replayOf = () => {
      let r: ServerEvent[] = [];
      hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') r = e.events; } });
      return r;
    };
    expect(replayOf().filter((e) => e.kind === 'agent' && e.e.t === 'turn-end')).toEqual([]);
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 2);
    expect(replayOf().filter((e) => e.kind === 'agent' && e.e.t === 'turn-end')).toHaveLength(1);
    s.close();
  });

  it('a reset that did not follow a /clear command keeps its result stored', async () => {
    const backend = fakeBackend([{ text: 'x', frames: [{ type: 'conversation_reset', new_conversation_id: '44444444-4444-4444-8444-444444444444' }] }]);
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    let stored = 0;
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') stored = e.events.filter((x) => x.kind === 'agent' && x.e.t === 'turn-end').length; } });
    expect(stored).toBe(1);
    s.close();
  });

  it('a history read that hangs times out: reported as a switch error, empty replay, switching released', async () => {
    const dirB = fs.realpathSync(mkExtra('nb-switch-h-'));
    const sid = '55555555-5555-4555-8555-555555555555';
    const backend = fakeBackend([{ text: 'x' }], { sessions: [{ id: sid, cwd: dirB, history: [{ role: 'user', text: 'old' }] }] });
    backend.history = () => new Promise(() => {});
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', historyTimeoutMs: 30 });
    await s.switch({ id: sid, dir: dirB });
    expect(s.switching()).toBe(false);
    expect(events.find((e) => e.kind === 'server-error')).toMatchObject({ where: 'switch', message: expect.stringContaining('transcript read timed out') });
    expect(events.some((e) => e.kind === 'resumed')).toBe(true);
    expect(events.some((e) => e.kind === 'user')).toBe(false);
    s.close();
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  describe('fork', () => {
    it('starts with fork and saves only the new id; after the id a restart resumes it without fork', async () => {
      const backend = fakeBackend([{ text: 'hi' }]);
      const { events, hub } = setup(backend);
      const m = await createSessionManager({ hub, backend, cwd: home, resume: 'src-id', fork: true });
      expect(backend.starts[0]).toMatchObject({ resume: 'src-id', fork: true });
      expect(lastSession(home)).toBeUndefined(); // the source is never written
      const ids: string[] = [];
      m.onSessionId((id) => ids.push(id));
      m.send({ id: 'u1', text: 'go' });
      await until(() => agentOf(events, 'turn-end').length === 1);
      const forked = m.info().id!;
      expect(forked).not.toBe('src-id');
      expect(lastSession(home)).toBe(forked);
      expect(ids).toEqual([forked]);
      await m.restart();
      expect(backend.starts[1]).toEqual(expect.objectContaining({ resume: forked }));
      expect(backend.starts[1]!.fork).toBeUndefined();
      expect(lastSession(home)).toBe(forked);
      m.close();
    });

    it('a restart before the first turn still forks and still does not save the source', async () => {
      const backend = fakeBackend([{ text: 'hi' }]);
      const { hub } = setup(backend);
      const m = await createSessionManager({ hub, backend, cwd: home, resume: 'src-id', fork: true });
      await m.restart();
      expect(backend.starts.map((x) => x.fork)).toEqual([true, true]);
      expect(lastSession(home)).toBeUndefined();
      m.close();
    });
  });
});
