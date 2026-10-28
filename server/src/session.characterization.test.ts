/**
 * Characterization of SessionManager (M7-10): what `server/src/session.ts` does today, pinned through its public API,
 * the hub's events, sessions.json and the backend's recorded calls, so the M7-11 restructuring cannot change it
 * silently. Scenarios already pinned by session.test.ts, switch.test.ts or commands.test.ts are not repeated (the
 * M7-10 report maps each scenario to its test).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES, type AgentEvent, type ServerEvent } from '@nota-bene/shared';
import { mapFrames } from './agent/claude/map.ts';
import { fakeBackend } from './agent/fake.ts';
import type { AgentBackend, AgentSession, PermissionAsk, SessionInfo } from './agent/types.ts';
import { EventHub } from './hub.ts';
import { createSessionManager, SwitchError } from './session.ts';
import { lastSession } from './state.ts';
import { prefsKey, readPrefs } from './prefs.ts';

let home: string;
let dirB: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-char-')));
  dirB = path.join(home, 'b');
  fs.mkdirSync(dirB);
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const SID = '55555555-5555-4555-8555-555555555555';

/** A hub with one live socket; `events` are the live events (replay frames excluded). */
function hubWithSocket() {
  const hub = new EventHub();
  const events: ServerEvent[] = [];
  hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind !== 'replay') events.push(e); } });
  return { hub, events };
}

/** What a socket attaching now would be replayed. */
function stored(hub: EventHub): ServerEvent[] {
  let r: ServerEvent[] = [];
  hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') r = e.events; } });
  return r;
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Agent = Extract<ServerEvent, { kind: 'agent' }>;
const agentOf = (events: ServerEvent[], t: AgentEvent['t']) => events.filter((e): e is Agent => e.kind === 'agent' && e.e.t === t);

/** The fake backend wrapped so that every agent call lands in `log`: start1:<resume>, send1:<uuid>:<priority>, interrupt1, close1. */
function spy(inner: ReturnType<typeof fakeBackend>, log: string[]): AgentBackend {
  let n = 0;
  return {
    ...inner,
    start: (o) => {
      const k = ++n;
      const a = inner.start(o);
      log.push(`start${k}${o.resume ? `:${o.resume}` : ''}`);
      const wrapped: AgentSession = {
        messages: a.messages,
        send: (m) => { log.push(`send${k}:${m.uuid}:${m.priority}`); a.send(m); },
        interrupt: () => { log.push(`interrupt${k}`); return a.interrupt(); },
        setPermissionMode: (m) => a.setPermissionMode(m),
        fileSuggestions: (q) => a.fileSuggestions(q),
        contextUsage: () => a.contextUsage(),
        usage: () => a.usage(),
        close: () => { log.push(`close${k}`); a.close(); },
      };
      return wrapped;
    },
  };
}

/** An agent whose SDK frames the test pushes (and whose loop it can end); records what it is sent. */
function scripted() {
  const sends: { uuid: string; text: string }[] = [];
  let push: (f: object) => void = () => {};
  let end: () => void = () => {};
  const backend: AgentBackend = {
    capabilities: CLAUDE_CAPABILITIES,
    listSessions: async () => [],
    sessionInfo: async () => null,
    history: async () => [],
    start: () => {
      const q: object[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      push = (f) => { q.push(f); wake?.(); };
      end = () => { ended = true; wake?.(); };
      return {
        messages: mapFrames((async function* () {
          while (true) {
            while (q.length) yield q.shift() as never;
            if (ended) return;
            await new Promise<void>((r) => { wake = r; });
          }
        })()),
        send: (m) => { sends.push({ uuid: m.uuid, text: m.text }); },
        interrupt: async () => {}, setPermissionMode: async () => {}, fileSuggestions: async () => [],
        contextUsage: async () => ({ used: 500_000, max: 1_000_000, pct: 50 }), usage: async () => ({ cost: null, limits: null }), close() {},
      };
    },
  };
  return { backend, sends, push: (f: object) => push(f), end: () => end() };
}
const result = (uuids: string[]) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, terminal_reason: 'completed', user_message_uuids: uuids });

/** A backend whose transcript read waits on a gate the test controls: `requested` resolves when the switch asks for it. */
function gated(inner: ReturnType<typeof fakeBackend>) {
  let open!: () => void;
  let ask!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const requested = new Promise<void>((r) => { ask = r; });
  const backend: AgentBackend = {
    ...inner,
    history: async (...a) => { ask(); await gate; return inner.history(...a); },
  };
  return { backend, requested, release: open };
}

/** `a` with some members replaced; the fake agent is a class, so a spread would lose its methods */
function over(a: AgentSession, patch: Partial<AgentSession>): AgentSession {
  return {
    messages: a.messages, send: (m) => a.send(m), interrupt: () => a.interrupt(), setPermissionMode: (m) => a.setPermissionMode(m),
    fileSuggestions: (q) => a.fileSuggestions(q), contextUsage: () => a.contextUsage(), usage: () => a.usage(), close: () => a.close(), ...patch,
  };
}

const longTurn = { text: 'x'.repeat(4000), chunk: 1, delayMs: 5 };

describe('SessionManager characterization', () => {
  // 1. (session.test.ts has 'a send during a switch is refused' but never looks at the agents or at busy)
  it('1. a send during a switch returns "switching": nothing is emitted, no agent is sent to, the switch stays busy', async () => {
    const log: string[] = [];
    const g = gated(fakeBackend([{ text: 'x' }], { sessions: [{ id: SID, cwd: dirB }] }));
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend: spy(g.backend as ReturnType<typeof fakeBackend>, log), cwd: home });
    const p = s.switch({ id: SID, dir: dirB });
    await g.requested; // the switch is inside its transcript read
    expect(s.switching()).toBe(true);
    const mark = events.length;
    expect(s.send({ id: 'u1', text: 'too early' })).toBe('switching');
    expect(events.length).toBe(mark);
    expect(s.busy()).toBe(true);
    g.release();
    await p;
    expect(events.some((e) => e.kind === 'user' || e.kind === 'server-error')).toBe(false);
    await tick(30);
    expect(log.filter((l) => l.startsWith('send'))).toEqual([]);
    expect(s.busy()).toBe(false);
    s.close();
  });

  // 2. (switch.test.ts:187 and :281 pin both over a socket, but not the agent calls)
  it('2a. a switch while a send waits is refused with SwitchError("switch"): nothing is torn down', async () => {
    const log: string[] = [];
    const inner = fakeBackend([longTurn], { sessions: [{ id: SID, cwd: dirB }] });
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend: spy(inner, log), cwd: home });
    s.send({ id: 'u1', text: 'long' });
    await until(() => agentOf(events, 'message-chunk').length > 2);
    const err = await s.switch({ id: SID, dir: dirB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwitchError);
    expect(err).toMatchObject({ where: 'switch' });
    expect(s.switching()).toBe(false);
    expect(s.busy()).toBe(true);
    expect(s.info().root).toBe(home);
    expect(log.filter((l) => l.startsWith('close') || l.startsWith('start'))).toEqual(['start1']);
    s.close();
  });

  it('2b. a restart while a send waits interrupts first, then closes and resumes the same id in a new agent', async () => {
    const log: string[] = [];
    const inner = fakeBackend([longTurn]);
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend: spy(inner, log), cwd: home });
    s.send({ id: 'u1', text: 'long' });
    await until(() => agentOf(events, 'message-chunk').length > 2);
    await s.restart();
    expect(log.filter((l) => /^(start|close|interrupt)/.test(l))).toEqual(['start1', 'interrupt1', 'close1', 'start2:fake-session']);
    expect(s.info().id).toBe('fake-session');
    expect(s.busy()).toBe(false);
    s.close();
  });

  // 3. pinned: session.test.ts 'a late message from the old agent after the reset is not emitted' (allowed false, no permission event)

  // 4. (commands.test.ts:96 and session.test.ts:863 pin the replay and the live-only result; the id listeners' (new, old) are new)
  it('4. /clear: the reset empties the hub, the following turn-end is not stored, the new id is saved, id listeners hear (new, old)', async () => {
    const backend = fakeBackend([{ text: 'x' }]);
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(stored(hub).some((e) => e.kind === 'user')).toBe(true);
    const heard: [string, string | null][] = [];
    s.onSessionId((id, prev) => heard.push([id, prev]));
    s.command('clear');
    await until(() => agentOf(events, 'turn-end').length === 2 && !s.busy());
    const newId = s.info().id!;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(newId).not.toBe('fake-session');
    expect(lastSession('/proj')).toBe(newId);
    expect(heard).toEqual([[newId, 'fake-session']]);
    expect(agentOf(events, 'reset')).toHaveLength(1); // seen live
    const replay = stored(hub);
    expect(replay.filter((e) => e.kind === 'user' || e.kind === 'agent')).toEqual([]); // old turns, the reset and the clear's result: none stored
    expect(replay.find((e) => e.kind === 'session')).toMatchObject({ id: newId });
    s.close();
  });

  // 5. (commands.test.ts:177/:233/:244 pin a command's own result and the normal turn arming; a normal turn that compacted is new)
  it('5. a normal turn that contained a compaction (`compacted`) does not arm idle compaction; the next normal turn does', async () => {
    const idle = { afterMs: 60, awayMs: 0, retryMs: 30, cacheMs: 5000, minTokens: 100 };
    const { backend, sends, push } = scripted();
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: '/proj', idle, idleOffInSettings: () => false });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => sends.length === 1);
    push({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9000 } });
    push(result(['u1']));
    await until(() => agentOf(events, 'compacted').length === 1 && agentOf(events, 'turn-end').length === 1);
    await tick(idle.afterMs * 4);
    expect(sends.filter((x) => x.text === '/compact')).toEqual([]);
    s.send({ id: 'u2', text: 'again' });
    await until(() => sends.length === 2);
    push(result(['u2']));
    await until(() => sends.some((x) => x.text === '/compact'));
    expect(events.find((e) => e.kind === 'user' && e.idle)).toMatchObject({ text: '/compact' });
    s.close();
  });

  // 6.
  it('6. a `cancelled` event drops that id from waiting: the next turn-end can end busy', async () => {
    const { backend, sends, push } = scripted();
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    s.send({ id: 'u1', text: 'one' });
    s.send({ id: 'u2', text: 'two' });
    await until(() => sends.length === 2);
    push({ type: 'command_lifecycle', command_uuid: 'u2', state: 'cancelled' });
    await until(() => agentOf(events, 'cancelled').length === 1);
    expect(agentOf(events, 'cancelled')[0]!.e).toEqual({ t: 'cancelled', sendId: 'u2' });
    expect(s.busy()).toBe(true); // u1 still waits
    push(result(['u1']));
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(s.busy()).toBe(false); // u2 never gets a result of its own
    s.close();
  });

  // 7. (session.test.ts:234 has one send and no busy(); :432 has a throw, not a clean end)
  it('7. the agent loop ends without close: one error turn-end answers every send the agent had; busy() is false after it', async () => {
    const { backend, sends, end } = scripted();
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: '/proj' });
    s.send({ id: 'u1', text: 'one' });
    s.send({ id: 'u2', text: 'two' });
    await until(() => sends.length === 2);
    expect(s.busy()).toBe(true);
    end();
    await until(() => agentOf(events, 'turn-end').length === 1);
    expect(agentOf(events, 'turn-end')[0]!.e).toEqual({ t: 'turn-end', stop: 'failed', secs: expect.any(Number), error: 'agent session ended', answers: ['u1', 'u2'], queued: 0 });
    expect(events.filter((e) => e.kind === 'server-error')).toEqual([{ kind: 'server-error', where: 'agent', message: 'agent session ended' }]);
    expect(s.busy()).toBe(false);
    s.close();
  });

  // 8. pinned: session.test.ts describe('fork') (3 tests: no source id saved, a restart before init keeps forking, after init it resumes without fork)

  // 9.
  it('9. setMode during a switch answers with the current mode and its ack; it is not applied', async () => {
    const inner = fakeBackend([{ text: 'x' }], { sessions: [{ id: SID, cwd: dirB }] });
    const g = gated(inner);
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend: g.backend, cwd: home });
    const p = s.switch({ id: SID, dir: dirB });
    await g.requested;
    expect(s.switching()).toBe(true);
    const mark = events.length;
    await s.setMode('plan', 'ack-1');
    expect(events.slice(mark)).toEqual([{ kind: 'mode', mode: 'auto', ack: 'ack-1' }]);
    expect(s.mode()).toBe('auto');
    expect(inner.setModes).toEqual([]);
    expect(readPrefs().modes[prefsKey(home)]).toBeUndefined();
    g.release();
    await p;
    expect(s.mode()).toBe('auto');
    expect(inner.setModes).toEqual([]);
    s.close();
  });

  // 10.
  it('10. close() during a switch: no agent is started afterwards', async () => {
    const inner = fakeBackend([{ text: 'x' }], { sessions: [{ id: SID, cwd: dirB }] });
    const g = gated(inner);
    const { hub } = hubWithSocket();
    const s = await createSessionManager({ hub, backend: g.backend, cwd: home });
    expect(inner.starts).toHaveLength(1);
    const p = s.switch({ id: SID, dir: dirB });
    await g.requested; // past the teardown, inside the history read
    s.close();
    expect(s.busy()).toBe(true); // the switch is still finishing
    g.release();
    // The requirement is "no agent starts after close". That the switch promise resolves (rather than rejects) is
    // today's incidental behaviour, which M7-11 may change on purpose.
    await p;
    await tick(30);
    expect(s.switching()).toBe(false);
    expect(inner.starts).toHaveLength(1);
  });

  // 11. (session.test.ts:96 and :207 pin interrupt-then-'now'; the order of the sends themselves is new)
  it('11. a forced send interrupts first, then sends with priority "now"; the sends reach the agent in the order they were made', async () => {
    const log: string[] = [];
    const inner = fakeBackend([{ text: 'x'.repeat(300), chunk: 1, delayMs: 2 }]);
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend: spy(inner, log), cwd: '/proj' });
    s.send({ id: 'A', text: 'a' });
    s.send({ id: 'B', text: 'b' });
    s.send({ id: 'C', text: 'c', force: true });
    s.send({ id: 'D', text: 'd' });
    await until(() => log.filter((l) => l.startsWith('send')).length === 4);
    expect(log.filter((l) => /^(send|interrupt)/.test(l))).toEqual(['send1:A:next', 'send1:B:next', 'interrupt1', 'send1:C:now', 'send1:D:next']);
    expect(events.filter((e) => e.kind === 'user').map((e) => (e as { id: string }).id)).toEqual(['A', 'B', 'C', 'D']);
    s.close();
  });

  // 12.
  it('12. a title lookup that answers after a switch is dropped', async () => {
    let calls = 0;
    let release!: (i: SessionInfo) => void;
    const gate = new Promise<SessionInfo>((r) => { release = r; });
    const inner = fakeBackend([{ text: 'x' }]);
    const backend: AgentBackend = {
      ...inner,
      sessionInfo: () => (++calls === 1 ? gate : Promise.resolve({ customTitle: 'fresh' })),
    };
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: home });
    s.send({ id: 'u1', text: 'hi' });
    await until(() => agentOf(events, 'turn-end').length === 1 && calls === 1); // the lookup after the result is in flight
    await s.restart(); // same id, so only the generation can tell the late answer is stale; its own lookup answers 'fresh'
    expect(s.info().title).toBe('fresh');
    release({ customTitle: 'stale' });
    await tick(30);
    expect(s.info().title).toBe('fresh');
    expect(events.filter((e) => e.kind === 'session' && e.title === 'stale')).toEqual([]);
    s.close();
  });

  // 13-16: parked from M7-11; they pin today's behaviour across a generation change (a restart is a switch to the same id)

  it('13. a switch denies the open permission asks before it closes the old agent', async () => {
    const inner = fakeBackend([{ text: 'x' }]);
    const order: string[] = [];
    let ask!: PermissionAsk;
    let asked!: Promise<boolean>;
    const backend: AgentBackend = {
      ...inner,
      start: (o) => {
        const a = inner.start(o);
        if (!ask) { ask = o.ask; asked = o.ask('Bash', { command: 'ls' }, new AbortController().signal); void asked.then(() => order.push('denied')); }
        return over(a, { close: () => { order.push('close'); queueMicrotask(() => order.push('after-close')); a.close(); } });
      },
    };
    const { hub } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: home });
    expect(s.busy()).toBe(true); // the ask is open
    await s.restart();
    expect(await asked).toBe(false);
    // 'close' is logged synchronously; the ask was settled before close() ran, so its continuation is queued ahead of the one queued inside close()
    expect(order.slice(0, 3)).toEqual(['close', 'denied', 'after-close']);
    s.close();
  });

  it('14. a switch cancels a scheduled title lookup of the old session', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const inner = fakeBackend([{ text: 'x' }, { text: 'y' }]);
      const backend: AgentBackend = { ...inner, sessionInfo: async () => { calls++; return { customTitle: 't' }; } };
      const { hub, events } = hubWithSocket();
      const s = await createSessionManager({ hub, backend, cwd: home });
      const turns = () => agentOf(events, 'turn-end').length;
      s.send({ id: 'u1', text: 'one' });
      await vi.advanceTimersByTimeAsync(50);
      expect(turns()).toBe(1);
      s.send({ id: 'u2', text: 'two' }); // within the throttle: the lookup is scheduled, not run
      await vi.advanceTimersByTimeAsync(50);
      expect(turns()).toBe(2);
      const restarting = s.restart();
      let done = false;
      void restarting.then(() => { done = true; });
      for (let i = 0; i < 200 && !done; i++) await vi.advanceTimersByTimeAsync(5); // file reads need real turns of the loop
      await restarting;
      const after = calls; // the new session's own title load
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(after);
      s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('15. a setMode still waiting on the old agent when a switch happens is not applied to the new session', async () => {
    const inner = fakeBackend([{ text: 'x' }]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const backend: AgentBackend = {
      ...inner,
      start: (o) => {
        const a = inner.start(o);
        return ++n === 1 ? over(a, { setPermissionMode: async () => { await gate; } }) : a;
      },
    };
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: home });
    const p = s.setMode('plan', 'ack-1');
    await s.restart();
    release();
    await p;
    expect(s.mode()).toBe('auto');
    expect(readPrefs().modes[prefsKey(home)]).toBeUndefined();
    expect(events.filter((e) => e.kind === 'mode' && e.mode === 'plan')).toEqual([]);
    expect(events).toContainEqual({ kind: 'mode', mode: 'auto', ack: 'ack-1' }); // it is still answered, with the mode as it stands
    expect(inner.startModes).toEqual(['auto', 'auto']);
    expect(inner.setModes).toEqual([]);
    s.close();
  });

  it('16. an interrupt that fails after a switch is not reported; one that fails in its own generation is', async () => {
    const inner = fakeBackend([{ text: 'x' }]);
    let fail!: (e: Error) => void;
    let n = 0;
    const backend: AgentBackend = {
      ...inner,
      start: (o) => {
        const a = inner.start(o);
        return ++n === 1 ? over(a, { interrupt: () => new Promise<void>((_, rej) => { fail = rej; }) }) : over(a, { interrupt: async () => { throw new Error('same gen'); } });
      },
    };
    const { hub, events } = hubWithSocket();
    const s = await createSessionManager({ hub, backend, cwd: home });
    s.interrupt();
    await s.restart();
    fail(new Error('old gen'));
    await tick(30);
    expect(events.filter((e) => e.kind === 'server-error' && e.where === 'interrupt')).toEqual([]);
    s.interrupt();
    await until(() => events.some((e) => e.kind === 'server-error' && e.where === 'interrupt'));
    expect(events.filter((e) => e.kind === 'server-error' && e.where === 'interrupt')).toEqual([{ kind: 'server-error', where: 'interrupt', message: 'same gen' }]);
    s.close();
  });
});
