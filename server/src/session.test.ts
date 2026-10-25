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
import { AttachmentStore } from './attachments.ts';

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
  it('strips base64 from tool_result images before the hub stores the user frame', async () => {
    const frame = (type: string, content: unknown[]) => ({ type, message: { content } });
    const img = { type: 'image', source: { type: 'base64', data: 'AAAA' } };
    const frames = [
      frame('user', [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'hi' }, img] }]),
      frame('assistant', [img]),
      { type: 'result', subtype: 'success' },
    ];
    const backend: AgentBackend = {
      history: async () => [],
      start: () => ({
        messages: (async function* () { yield* frames as never[]; await new Promise(() => {}); })(),
        send() {}, interrupt: async () => {}, fileSuggestions: async () => [], close() {},
      }),
    };
    const { events, make } = setup(backend);
    await make();
    await until(() => sdkOf(events, 'result').length === 1);
    expect(sdkOf(events, 'user')[0]).toMatchObject({
      m: { message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'hi' }, { type: 'image' }] }] } },
    });
    expect(JSON.stringify(sdkOf(events, 'user'))).not.toContain('AAAA');
    expect(JSON.stringify(sdkOf(events, 'assistant'))).toContain('AAAA'); // only tool_result images are stripped
  });

  it('fileSuggestions delegates to the agent and rejects once it has died', async () => {
    const backend: AgentBackend = {
      history: async () => [],
      start: () => ({
        messages: (async function* () { await new Promise((r) => setTimeout(r, 30)); throw new Error('boom'); yield* []; })(),
        send() {}, interrupt: async () => {}, fileSuggestions: async (q) => [`hit-${q}`], close() {},
      }),
    };
    const { events, make } = setup(backend);
    const s = await make();
    expect(await s.fileSuggestions('a')).toEqual(['hit-a']);
    await until(() => sdkOf(events, 'result').length === 1); // the crash became an error result; the agent is gone
    await expect(s.fileSuggestions('a')).rejects.toThrow('no agent');
  });

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
          fileSuggestions: async () => [], close: () => a.close(),
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
    s.send({ id: 'u1', text: 'hi' });
    await until(() => events.some((e) => e.kind === 'session' && e.id !== null));
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
      subtype: 'error_during_execution', is_error: true, errors: ['fake backend crash'],
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
          fileSuggestions: async () => [], close: () => a.close(),
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
          fileSuggestions: async () => [], close: () => a.close(),
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
    expect(sdkOf(events, 'result')[1]).toMatchObject({ m: { is_error: true, errors: ['agent session ended'] } });
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
        fileSuggestions: async () => [], close: () => { closed++; },
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
          fileSuggestions: async () => [], close: () => a.close(),
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
          fileSuggestions: async () => [], close: () => {},
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

  it('resume: history, then exactly one resumed marker, then live events; one session per distinct id', async () => {
    const inner = fakeBackend([{ text: 'a' }]);
    const old: ServerEvent[] = [{ kind: 'user', id: 'h1', text: 'before', ts: 1, historic: true }];
    const backend: AgentBackend = { start: inner.start, history: async () => old };
    const { hub, events } = setup(backend);
    const s = await createSessionManager({ hub, backend, cwd: '/proj', resume: 'old-session' });
    const replayed: ServerEvent[] = [];
    hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind === 'replay') replayed.push(...e.events); } });
    expect(replayed.map((e) => e.kind)).toEqual(['user', 'resumed', 'session']);
    expect(replayed[1]).toEqual({ kind: 'resumed', id: 'old-session' });
    expect(replayed[2]).toEqual({ kind: 'session', id: 'old-session', root: '/proj', title: null, model: null });
    s.send({ id: 'u1', text: 'one' });
    await until(() => sdkOf(events, 'result').length === 1);
    s.send({ id: 'u2', text: 'two' });
    await until(() => sdkOf(events, 'result').length === 2);
    expect(sdkOf(events, 'system')).toHaveLength(2); // the CLI sends init at the start of every turn
    expect(events.filter((e) => e.kind === 'resumed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'session')).toHaveLength(1); // same id: no new session event
    expect(lastSession('/proj')).toBe('old-session');
  });

  it('fresh start: a session event with null id, then one more when the first init names the id', async () => {
    const { events, make } = setup(fakeBackend([{ text: 'a' }]));
    const s = await make();
    s.send({ id: 'u1', text: 'one' });
    await until(() => sdkOf(events, 'result').length === 1);
    s.send({ id: 'u2', text: 'two' });
    await until(() => sdkOf(events, 'result').length === 2);
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
      history: inner.history,
      start: (o) => {
        const a = inner.start(o);
        return { messages: a.messages, send: () => { throw new Error('stdin closed'); }, interrupt: () => a.interrupt(), fileSuggestions: async () => [], close: () => a.close() };
      },
    };
    const { hub, events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'u1', text: 'hi' });
    await until(() => sdkOf(events, 'result').length === 1);
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('server-error')).toBeLessThan(events.findIndex((e) => e.kind === 'sdk' && (e.m as { type: string }).type === 'result'));
    expect((sdkOf(events, 'result')[0] as { m: unknown }).m).toMatchObject({
      subtype: 'error_during_execution', is_error: true, duration_ms: 0, errors: ['stdin closed'], user_message_uuid: 'u1', user_message_uuids: ['u1'],
    });
    const attached: ServerEvent[] = [];
    hub.attach({ send: (d) => attached.push(...(JSON.parse(d) as { events: ServerEvent[] }).events) });
    expect((await feedOf(attached)).busy).toBe(false);
  });

  it('a crash with a queued send leaves busy false', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sent = 0;
    const backend: AgentBackend = {
      history: async () => [],
      start: () => ({
        messages: (async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as never;
          await gate;
          throw new Error('dead');
        })(),
        send: () => { sent++; },
        interrupt: async () => {},
        fileSuggestions: async () => [], close: () => {},
      }),
    };
    const { hub, events, make } = setup(backend);
    const s = await make();
    s.send({ id: 'A', text: 'one' });
    s.send({ id: 'B', text: 'two' });
    await until(() => sent === 2);
    release();
    await until(() => sdkOf(events, 'result').length === 1);
    const attached: ServerEvent[] = [];
    hub.attach({ send: (d) => attached.push(...(JSON.parse(d) as { events: ServerEvent[] }).events) });
    expect((sdkOf(events, 'result')[0] as { m: unknown }).m).toMatchObject({ is_error: true, errors: ['dead'] });
    const f = await feedOf(attached);
    expect(f.waiting).toEqual([]);
    expect(f.busy).toBe(false);
  });

  describe('image attachments', () => {
    const png = (n: string) => Buffer.from(`png-${n}`);

    it('a send with two refs reaches the agent as images and the hub event carries refs only', async () => {
      const attachments = new AttachmentStore({ dir: path.join(home, 'att') });
      const refs = ['a', 'b'].map((n, i) => ({ id: attachments.put(png(n), 'image/png'), mediaType: 'image/png' as const, label: `Comment ${i + 1}` }));
      const got: unknown[] = [];
      const backend: AgentBackend = {
        history: async () => [],
        start: () => ({
          messages: (async function* () { await new Promise(() => {}); })(),
          send: (m) => { got.push(m); }, interrupt: async () => {}, fileSuggestions: async () => [], close() {},
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
        history: async () => [],
        start: () => ({
          messages: (async function* () { await new Promise(() => {}); })(),
          send: (m) => { got.push(m); }, interrupt: async () => {}, fileSuggestions: async () => [], close() {},
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

    it('fake echoImages reports how many images the turn received', async () => {
      const attachments = new AttachmentStore({ dir: path.join(home, 'att') });
      const ref = { id: attachments.put(png('a'), 'image/png'), mediaType: 'image/png' as const, label: 'x' };
      const hub = new EventHub();
      const events: ServerEvent[] = [];
      hub.attach({ send: (d) => { const e = JSON.parse(d) as ServerEvent; if (e.kind !== 'replay') events.push(e); } });
      const s = await createSessionManager({ hub, backend: fakeBackend([{ text: 'ok', echoImages: true }]), cwd: '/proj', attachments });
      s.send({ id: 'u1', text: 'hi', images: [ref, ref] });
      await until(() => sdkOf(events, 'result').length === 1);
      expect(JSON.stringify(sdkOf(events, 'assistant'))).toContain('ok\\nimages: 2');
    });
  });
});
