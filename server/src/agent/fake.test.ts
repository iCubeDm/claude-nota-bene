import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES, type AgentEvent } from '@nota-bene/shared';
import type { SDKMessage } from './claude/map.ts';
import { fakeBackend, fakeFromScript, type FakeTurn } from './fake.ts';
import type { PermissionAsk } from './types.ts';

const send = { uuid: 'u1', text: 'hi', priority: 'next' } as const;
const yes: PermissionAsk = async () => true;

function run(turns: FakeTurn[], ask: PermissionAsk = yes) {
  const s = fakeBackend(turns).start({ cwd: '/tmp', permissionMode: 'auto', ask });
  const it = s.frames[Symbol.asyncIterator](); // the SDK frames; `messages` is them through the Claude mapper
  return { s, it, next: async () => (await it.next()).value as SDKMessage };
}

async function collectTurn(turns: FakeTurn[], ask?: PermissionAsk) {
  const { s, it } = run(turns, ask);
  s.send(send);
  const out: SDKMessage[] = [];
  while (true) {
    const m = (await it.next()).value as SDKMessage;
    out.push(m);
    if (m.type === 'result') break;
  }
  s.close();
  return out;
}

describe('fake backend', () => {
  it('messages are its SDK frames through the Claude mapper (R-M7-13)', async () => {
    const s = fakeBackend([{ text: 'hi', tools: [{ name: 'Bash', input: { command: 'ls' }, output: 'a' }] }]).start({ cwd: '/tmp', permissionMode: 'auto', ask: yes });
    const it = s.messages[Symbol.asyncIterator]();
    s.send(send);
    const out: AgentEvent[] = [];
    while (true) {
      const e = (await it.next()).value as AgentEvent;
      out.push(e);
      if (e.t === 'turn-end') break;
    }
    s.close();
    expect(out).toEqual([
      { t: 'init', sessionId: 'fake-session' },
      { t: 'message-start' },
      { t: 'message-chunk', text: 'hi' },
      { t: 'message', id: 'fake-a-1:0', text: 'hi' },
      { t: 'tool-call', id: 'fake-tool-1-0', name: 'Bash', input: { command: 'ls' }, sub: false },
      { t: 'tool-update', id: 'fake-tool-1-0', text: 'a', isError: false },
      { t: 'turn-end', stop: 'done', secs: 0, answers: ['u1'], queued: 0 },
    ]);
  });

  it('streams a tool_result user message for each tool use, before the result', async () => {
    const out = await collectTurn([{ text: 'x', tools: [
      { name: 'Bash', input: { command: 'ls' }, output: 'a\nb' },
      { name: 'Bash', input: { command: 'false' }, output: 'no', isError: true },
    ] }]);
    expect(out.map((m) => m.type)).toEqual(['system', 'stream_event', 'stream_event', 'assistant', 'user', 'result']);
    expect(out[4]).toMatchObject({
      type: 'user', parent_tool_use_id: null,
      message: { content: [
        { type: 'tool_result', tool_use_id: 'fake-tool-1-0', content: 'a\nb' },
        { type: 'tool_result', tool_use_id: 'fake-tool-1-1', content: 'no', is_error: true },
      ] },
    });
  });

  it('streams deltas then assistant then result', async () => {
    const out = await collectTurn([{ text: 'hello world', chunk: 5 }]);
    expect(out.map((m) => m.type)).toEqual(['system', 'stream_event', 'stream_event', 'stream_event', 'stream_event', 'assistant', 'result']);
  });

  it('assistant text equals concatenated deltas', async () => {
    const out = await collectTurn([{ text: 'hello world', chunk: 5 }]);
    const deltas = out.flatMap((m) => {
      const e = (m as { event?: { type: string; delta?: { text: string } } }).event;
      return m.type === 'stream_event' && e?.type === 'content_block_delta' ? [e.delta!.text] : [];
    });
    const a = out.find((m) => m.type === 'assistant') as unknown as { message: { content: { type: string; text?: string }[] } };
    expect(a.message.content.find((b) => b.type === 'text')?.text).toBe(deltas.join(''));
  });

  it('ask waits for permission', async () => {
    const ask: PermissionAsk = () => new Promise((r) => setTimeout(() => r(false), 50));
    const { s, it } = run([{ text: 'x', ask: { toolName: 'Bash', input: { command: 'ls' } } }], ask);
    s.send(send);
    let tAssistant = 0;
    while (true) {
      const m = (await it.next()).value as SDKMessage;
      if (m.type === 'assistant') tAssistant = Date.now();
      if (m.type === 'result') break;
    }
    expect(Date.now() - tAssistant).toBeGreaterThanOrEqual(45);
    s.close();
  });

  it('interrupt mid-turn ends like the CLI: subtype success, terminal_reason aborted_streaming', async () => {
    const { s, it, next } = run([{ text: 'a'.repeat(100), chunk: 1, delayMs: 5 }]);
    s.send(send);
    await next(); // init
    await next(); // content_block_start
    await next(); // first delta
    await s.interrupt();
    const rest: SDKMessage[] = [];
    while (true) {
      const m = (await it.next()).value as SDKMessage;
      rest.push(m);
      if (m.type === 'result') break;
    }
    expect(rest.filter((m) => m.type === 'stream_event').length).toBeLessThan(5);
    expect(rest.some((m) => m.type === 'assistant')).toBe(false);
    expect(rest.at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming' });
    s.close();
  });

  it('emits init at the start of every turn, like the CLI, and keeps the resumed id', async () => {
    const s = fakeBackend([{ text: 'x' }]).start({ cwd: '/tmp', resume: 'r1', permissionMode: 'auto', ask: yes });
    const it = s.frames[Symbol.asyncIterator]();
    const types: string[] = [];
    const ids = new Set<string>();
    for (const uuid of ['u1', 'u2']) {
      s.send({ ...send, uuid });
      while (true) {
        const m = (await it.next()).value as SDKMessage;
        types.push(m.type === 'system' ? `system:${(m as { subtype: string }).subtype}` : m.type);
        ids.add((m as { session_id: string }).session_id);
        if (m.type === 'result') break;
      }
    }
    expect(types.filter((t) => t === 'system:init')).toHaveLength(2);
    expect(types[0]).toBe('system:init');
    expect(types[types.indexOf('result') + 1]).toBe('system:init');
    expect([...ids]).toEqual(['r1']);
    s.close();
  });

  it('interrupt while idle resolves and emits nothing', async () => {
    const { s, it } = run([{ text: 'x' }]);
    await expect(s.interrupt()).resolves.toBeUndefined();
    const pending = it.next();
    const raced = await Promise.race([pending.then(() => 'emitted'), new Promise((r) => setTimeout(() => r('quiet'), 30))]);
    expect(raced).toBe('quiet');
    s.close();
    expect((await pending).done).toBe(true);
  });

  it('crash makes the iterator throw', async () => {
    const { s, it } = run([{ text: 'hello world', chunk: 5, crash: true }]);
    s.send(send);
    await it.next(); // init
    await it.next(); // block start
    await it.next(); // first delta
    await expect(it.next()).rejects.toThrow('fake backend crash');
    s.close();
  });

  it('a send during a running turn runs as its own turn; each result names its send, queued_turn_count 0 as the CLI reports', async () => {
    const { s, it } = run([{ text: 'a'.repeat(20), chunk: 1, delayMs: 2 }]);
    s.send(send);
    const results: SDKMessage[] = [];
    let sent = false;
    while (results.length < 2) {
      const m = (await it.next()).value as SDKMessage;
      if (!sent && m.type === 'stream_event') { s.send({ ...send, uuid: 'u2' }); sent = true; }
      if (m.type === 'result') results.push(m);
    }
    expect(results.map((r) => (r as { queued_turn_count?: number }).queued_turn_count)).toEqual([0, 0]);
    expect(results.map((r) => (r as { user_message_uuids?: string[] }).user_message_uuids)).toEqual([['u1'], ['u2']]);
    expect(results[0]).toMatchObject({ subtype: 'success', terminal_reason: 'completed' });
    s.close();
  });

  it('interrupt during a permission ask ends with terminal_reason aborted_tools', async () => {
    const ask: PermissionAsk = () => new Promise(() => {});
    const { s, it } = run([{ text: 'x', ask: { toolName: 'Bash', input: {} } }], ask);
    s.send(send);
    while (((await it.next()).value as SDKMessage).type !== 'assistant');
    await s.interrupt();
    expect((await it.next()).value).toMatchObject({ type: 'result', subtype: 'success', terminal_reason: 'aborted_tools' });
    s.close();
  });

  it('result shapes match the real-CLI fixture (type, subtype, is_error, terminal_reason, queued_turn_count)', async () => {
    const pick = (m: unknown) => {
      const r = m as Record<string, unknown>;
      return {
        type: r.type, subtype: r.subtype, is_error: r.is_error, terminal_reason: r.terminal_reason,
        queued: r.queued_turn_count, uuids: Array.isArray(r.user_message_uuids) ? r.user_message_uuids.length : r.user_message_uuids,
      };
    };
    const fixture = JSON.parse(fs.readFileSync(new URL('../../test/fixtures/real-frames.json', import.meta.url), 'utf8')) as { events: { kind: string; m?: { type?: string; terminal_reason?: string } }[] };
    const real = fixture.events.flatMap((e) => (e.kind === 'sdk' && e.m?.type === 'result' ? [e.m] : []));
    const realOk = real.find((m) => m.terminal_reason === 'completed');
    const realAborted = real.find((m) => m.terminal_reason === 'aborted_streaming');
    const ok = (await collectTurn([{ text: 'hi' }])).at(-1);
    expect(pick(ok)).toEqual(pick(realOk));
    const { s, it, next } = run([{ text: 'a'.repeat(100), chunk: 1, delayMs: 5 }]);
    s.send(send);
    await next(); await next(); await next();
    await s.interrupt();
    let m: SDKMessage;
    do m = (await it.next()).value as SDKMessage; while (m.type !== 'result');
    expect(pick(m)).toEqual(pick(realAborted));
    s.close();
  });
  describe('M7-09 capabilities', () => {
    it('mirror Claude unless the script says otherwise (object form only; a bare turn array has none)', () => {
      expect(fakeFromScript([{ text: 'a' }], '/p').capabilities).toEqual(CLAUDE_CAPABILITIES);
      expect(fakeFromScript({ turns: [{ text: 'a' }] }, '/p').capabilities).toEqual(CLAUDE_CAPABILITIES);
      expect(fakeFromScript({ turns: [{ text: 'a' }], capabilities: { compact: false, modes: ['default'] } }, '/p').capabilities)
        .toEqual({ ...CLAUDE_CAPABILITIES, compact: false, modes: ['default'] });
    });
  });

  describe('M4-16 script fields', () => {
    it('a turn with `match` runs for a prompt containing it and does not use up the sequence', async () => {
      const turns: FakeTurn[] = [{ text: 'first' }, { text: 'boom reply', match: 'boom' }, { text: 'second' }];
      const { s, it } = run(turns);
      const replies: string[] = [];
      for (const text of ['one', 'go boom', 'two']) {
        s.send({ uuid: text, text, priority: 'next' });
        let m: SDKMessage;
        do {
          m = (await it.next()).value as SDKMessage;
          if (m.type === 'result') replies.push((m as unknown as { result: string }).result);
        } while (m.type !== 'result');
      }
      expect(replies).toEqual(['first', 'boom reply', 'second']);
      s.close();
    });

    it('frames follow init (with the session id) and a sleep step only waits', async () => {
      const out = await collectTurn([{ text: 'x', frames: [
        { type: 'system', subtype: 'task_started', task_id: 't1', description: 'job' },
        { sleepMs: 1 },
        { type: 'system', subtype: 'task_notification', task_id: 't1' },
      ] }]);
      expect(out.map((m) => (m as { subtype?: string }).subtype ?? m.type)).toEqual(['init', 'task_started', 'task_notification', 'stream_event', 'stream_event', 'assistant', 'success']);
      expect(out[1]).toMatchObject({ session_id: 'fake-session', task_id: 't1' });
    });

    it('a suggestion is a prompt_suggestion frame after the result', async () => {
      const { s, it } = run([{ text: 'x', suggestion: 'next step' }]);
      s.send(send);
      let m: SDKMessage;
      do m = (await it.next()).value as SDKMessage; while (m.type !== 'result');
      expect((await it.next()).value).toMatchObject({ type: 'prompt_suggestion', suggestion: 'next step', session_id: 'fake-session' });
      s.close();
    });

    it('an allowed ask with onAllow announces the mode the CLI drops to; a denied one does not', async () => {
      const turns: FakeTurn[] = [{ text: 'x', ask: { toolName: 'ExitPlanMode', input: { plan: 'p' }, onAllow: 'default' } }];
      const allowed = await collectTurn(turns, async () => true);
      expect(allowed.find((m) => (m as { subtype?: string }).subtype === 'status')).toMatchObject({ permissionMode: 'default' });
      const denied = await collectTurn(turns, async () => false);
      expect(denied.some((m) => (m as { subtype?: string }).subtype === 'status')).toBe(false);
    });

    it('historyDelayMs holds back history()', async () => {
      const b = fakeBackend([], { sessions: [{ id: 's1', cwd: '/x', history: [{ role: 'user', text: 'hi' }] }], historyDelayMs: 60 });
      const t0 = Date.now();
      const h = await b.history('s1', '/x', undefined as never, () => {});
      expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
      expect(h).toHaveLength(1);
    });

    it('history replays assistant lines as agent message events', async () => {
      const b = fakeBackend([], { sessions: [{ id: 's1', cwd: '/x', history: [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }] }] });
      expect(await b.history('s1', '/x', undefined as never, () => {})).toEqual([
        { kind: 'user', id: 'fake-h-0', text: 'q', historic: true, ts: 0 },
        { kind: 'agent', e: { t: 'message', id: 'fake-h-1:0', text: 'a' }, ts: 0 },
      ]);
    });
  });
});
