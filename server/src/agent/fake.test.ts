import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { fakeBackend, type FakeTurn } from './fake.ts';
import type { PermissionAsk } from './types.ts';

const send = { uuid: 'u1', text: 'hi', priority: 'next' } as const;
const yes: PermissionAsk = async () => true;

function run(turns: FakeTurn[], ask: PermissionAsk = yes) {
  const s = fakeBackend(turns).start({ cwd: '/tmp', ask });
  const it = s.messages[Symbol.asyncIterator]();
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
    const s = fakeBackend([{ text: 'x' }]).start({ cwd: '/tmp', resume: 'r1', ask: yes });
    const it = s.messages[Symbol.asyncIterator]();
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
});
