import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { fakeBackend } from './agent/fake.ts';
import type { FakeTurn } from './agent/fake.ts';
import type { AgentBackend } from './agent/types.ts';
import { EventHub } from './hub.ts';
import { createSessionManager } from './session.ts';
import { lastSession } from './state.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-session-')); process.env.NOTA_BENE_HOME = home; });
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
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

const sdkOf = (events: ServerEvent[], type: string) =>
  events.filter((e) => e.kind === 'sdk' && (e.m as { type: string }).type === type);

describe('session manager', () => {
  it('send emits user then the agent reply', async () => {
    const { events, make } = setup(fakeBackend([{ text: 'hello' }]));
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => sdkOf(events, 'result').length === 1);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('user')).toBeGreaterThanOrEqual(0);
    const a = events.findIndex((e) => e.kind === 'sdk' && (e.m as { type: string }).type === 'assistant');
    expect(kinds.indexOf('user')).toBeLessThan(a);
  });

  it('force send interrupts and uses priority now', async () => {
    const calls: { priority: string }[] = [];
    let interrupts = 0;
    const inner = fakeBackend([{ text: 'x'.repeat(200), chunk: 1, delayMs: 5 }, { text: 'second' }]);
    const backend: AgentBackend = {
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return {
          messages: a.messages,
          send: (m) => { calls.push({ priority: m.priority }); a.send(m); },
          interrupt: () => { interrupts++; return a.interrupt(); },
          close: () => a.close(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'long' });
    await until(() => sdkOf(events, 'stream_event').length > 2);
    s.send({ id: 'u2', text: 'now', force: true });
    await until(() => calls.length === 2);
    expect(interrupts).toBe(1);
    expect(calls.map((c) => c.priority)).toEqual(['next', 'now']);
    await until(() => sdkOf(events, 'result').length === 2);
  });

  it('permission round-trip', async () => {
    const turns: FakeTurn[] = [{ text: 'ok', ask: { toolName: 'Bash', input: { command: 'ls' } } }];
    const { events, make } = setup(fakeBackend(turns));
    const s = await make();
    s.send({ id: 'u1', text: 'run' });
    await until(() => events.some((e) => e.kind === 'permission'));
    const p = events.find((e) => e.kind === 'permission') as Extract<ServerEvent, { kind: 'permission' }>;
    expect(p.toolName).toBe('Bash');
    expect(sdkOf(events, 'result')).toHaveLength(0);
    s.answer('unknown-id', true); // no-op
    s.answer(p.id, true);
    await until(() => sdkOf(events, 'result').length === 1);
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
    await until(() => events.some((e) => e.kind === 'session'));
    expect(lastSession('/proj')).toBe('fake-session');
    expect(s.info()).toEqual({ id: 'fake-session', root: '/proj' });
  });

  it('crash surfaces an error and recovers', async () => {
    const crash = fakeBackend([{ text: 'boom!', crash: true }]);
    const ok = fakeBackend([{ text: 'fine' }]);
    const resumes: (string | undefined)[] = [];
    let n = 0;
    const backend: AgentBackend = {
      history: ok.history,
      start: (o) => { resumes.push(o.resume); return (n++ === 0 ? crash : ok).start(o); },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'server-error'));
    await until(() => sdkOf(events, 'result').length === 1);
    expect((sdkOf(events, 'result')[0] as { m: unknown }).m).toMatchObject({
      subtype: 'error_during_execution', is_error: true, result: 'fake backend crash',
    });
    s.send({ id: 'u2', text: 'again' });
    await until(() => sdkOf(events, 'result').length === 2);
    expect(resumes).toEqual([undefined, 'fake-session']);
    expect((sdkOf(events, 'assistant').at(-1) as { m: { message: { content: { text: string }[] } } }).m.message.content[0]!.text).toBe('fine');
  });

  it('every force send interrupts first, even after an earlier force', async () => {
    const log: string[] = [];
    const inner = fakeBackend([{ text: 'x'.repeat(300), chunk: 1, delayMs: 5 }]);
    const backend: AgentBackend = {
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return {
          messages: a.messages,
          send: (m) => { log.push(`send:${m.priority}`); a.send(m); },
          interrupt: () => { log.push('interrupt'); return a.interrupt(); },
          close: () => a.close(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u0', text: 'idle force', force: true }); // idle: must not throw
    s.send({ id: 'a', text: 'A' });
    await until(() => sdkOf(events, 'stream_event').length > 2);
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
      history: first.history,
      start: (o) => {
        resumes.push(o.resume);
        const a = (n++ === 0 ? first : second).start(o);
        if (n > 1) return a;
        return {
          ...a,
          send: (m) => a.send(m),
          interrupt: () => a.interrupt(),
          close: () => a.close(),
          messages: (async function* () {
            for await (const m of a.messages) {
              yield m;
              if ((m as { type: string }).type === 'result') return;
            }
          })(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'server-error'));
    await until(() => sdkOf(events, 'result').length === 2);
    s.send({ id: 'u2', text: 'again' });
    await until(() => sdkOf(events, 'result').length === 3);
    expect(resumes).toEqual([undefined, 'fake-session']);
    expect(sdkOf(events, 'result')[1]).toMatchObject({ m: { is_error: true, result: 'agent session ended' } });
  });

  it('crash with a pending permission denies it and closes the agent', async () => {
    let closed = 0;
    const backend: AgentBackend = {
      history: async () => [],
      start: (o) => ({
        messages: (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 's1' } as never;
          void o.ask('Bash', {}, new AbortController().signal);
          await new Promise((r) => setTimeout(r, 20));
          throw new Error('dead');
        })(),
        send: () => {},
        interrupt: async () => {},
        close: () => { closed++; },
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
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return {
          messages: a.messages,
          send: (m) => { if (first) { first = false; throw new Error('send failed'); } a.send(m); },
          interrupt: () => a.interrupt(),
          close: () => a.close(),
        };
      },
    };
    const { events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'lost' });
    await until(() => events.some((e) => e.kind === 'server-error' && e.where === 'send'));
    s.send({ id: 'u2', text: 'ok' });
    await until(() => sdkOf(events, 'result').length === 1);
  });

  it('a send queued across a crash is delivered to the fresh agent', async () => {
    const resumes: (string | undefined)[] = [];
    const delivered: string[] = [];
    let n = 0;
    const backend: AgentBackend = {
      history: async () => [],
      start: (o) => {
        resumes.push(o.resume);
        const mine = n++;
        return {
          messages: (async function* () {
            yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as never;
            if (mine === 0) { await new Promise((r) => setTimeout(r, 10)); throw new Error('dead'); }
            await new Promise(() => {});
          })(),
          send: (m) => { delivered.push(`${mine}:${m.text}`); },
          interrupt: () => new Promise<void>((r) => setTimeout(r, 40)),
          close: () => {},
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

  it('a failing transcript read on resume is reported and starts with empty history', async () => {
    const inner = fakeBackend([{ text: 'fine' }]);
    const backend: AgentBackend = { start: inner.start, history: async () => { throw new Error('transcript gone'); } };
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', resume: 'old' });
    expect(events.find((e) => e.kind === 'server-error')).toMatchObject({ where: 'history', message: 'transcript gone' });
    const replayed: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') replayed.push(...e.events); } });
    expect(replayed.some((e) => e.kind === 'user' || e.kind === 'sdk')).toBe(false);
    s.send({ id: 'u1', text: 'hi' });
    await until(() => sdkOf(events, 'result').length === 1);
  });
});
