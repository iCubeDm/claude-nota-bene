import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nota-bene/shared';
import { mapSdk } from './map.ts';

const f = (m: object) => m as unknown as SDKMessage;
const map = (m: object): AgentEvent[] => mapSdk(f(m));

const real = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/real-frames.json', import.meta.url), 'utf8')) as {
  events: { kind: string; m?: { type: string; subtype?: string; event?: { type: string } } }[];
};
const realFrames = real.events.filter((e) => e.kind === 'sdk').map((e) => e.m!);
const one = (pred: (m: (typeof realFrames)[number]) => boolean) => realFrames.find(pred)!;

describe('mapSdk: real frames', () => {
  it('system init -> init with session, model and mode', () => {
    expect(map(one((m) => m.subtype === 'init'))).toEqual([
      { t: 'init', sessionId: '5f0c2a9e-7d41-4c4b-9a53-2f1e8b6d0c77', model: 'claude-opus-4-1', mode: 'auto' },
    ]);
  });

  it('stream_event message_start / content_block_stop / message_delta / message_stop -> nothing', () => {
    for (const t of ['message_start', 'content_block_stop', 'message_delta', 'message_stop']) {
      expect(map(one((m) => m.event?.type === t))).toEqual([]);
    }
  });

  it('stream_event text block start and deltas', () => {
    expect(map(one((m) => m.event?.type === 'content_block_start'))).toEqual([{ t: 'message-start' }]);
    expect(map(one((m) => m.event?.type === 'content_block_delta'))).toEqual([{ t: 'message-chunk', text: 'Hi' }]);
  });

  it('assistant text block -> message with id uuid:index', () => {
    const m = one((x) => x.type === 'assistant') as unknown as { uuid: string };
    expect(map(m)).toEqual([{ t: 'message', id: `${m.uuid}:0`, text: 'Hi there!' }]);
  });

  it('result success -> turn-end done', () => {
    const m = one((x) => x.type === 'result' && x.subtype === 'success') as unknown as { user_message_uuids?: string[]; user_message_uuid?: string };
    const [e] = map(m);
    expect(e).toMatchObject({ t: 'turn-end', stop: 'done', secs: 2, queued: 0 });
    expect((e as { error?: string }).error).toBeUndefined();
  });

  it('result with is_error -> failed with the text, names its send (c5 in the fixture)', () => {
    const m = realFrames.find((x) => x.type === 'result' && (x as { is_error?: boolean }).is_error && x.subtype === 'success')!;
    const [e] = map(m) as Extract<AgentEvent, { t: 'turn-end' }>[];
    expect(e).toMatchObject({ stop: 'failed', error: 'API Error: 529 Overloaded' });
    expect(e!.answers).toEqual(['c5']);
  });

  it('result error_during_execution with is_error -> failed', () => {
    const m = realFrames.find((x) => x.subtype === 'error_during_execution')!;
    expect(map(m)[0]).toMatchObject({ t: 'turn-end', stop: 'failed' });
  });

  it('every real frame maps without throwing; each type is covered above', () => {
    for (const m of realFrames) expect(Array.isArray(map(m))).toBe(true);
    const kinds = new Set(realFrames.map((m) => `${m.type}/${m.subtype ?? m.event?.type ?? ''}`));
    expect([...kinds].sort()).toEqual([
      'assistant/', 'command_lifecycle/', 'result/error_during_execution', 'result/success', 'stream_event/content_block_delta',
      'stream_event/content_block_start', 'stream_event/content_block_stop', 'stream_event/message_delta', 'stream_event/message_start',
      'stream_event/message_stop', 'system/init', 'user/',
    ]);
  });

  it('command_lifecycle queued/started -> nothing', () => {
    for (const state of ['queued', 'started']) {
      expect(map(realFrames.find((x) => x.type === 'command_lifecycle' && (x as unknown as { state: string }).state === state)!)).toEqual([]);
    }
  });

  it('user frame from the fixture (echo) -> nothing', () => {
    expect(map(one((x) => x.type === 'user'))).toEqual([]);
  });
});

describe('mapSdk: stream and assistant', () => {
  it('sub-agent streams are ignored', () => {
    const start = { type: 'stream_event', parent_tool_use_id: 'T', event: { type: 'content_block_start', content_block: { type: 'text' } } };
    const delta = { type: 'stream_event', parent_tool_use_id: 'T', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } };
    expect(map(start)).toEqual([]);
    expect(map(delta)).toEqual([]);
  });

  it('non-text block start and non-text delta -> nothing', () => {
    expect(map({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } })).toEqual([]);
    expect(map({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } })).toEqual([]);
  });

  it('assistant: text and tool_use blocks keep their index in the id; tool-call carries input and sub', () => {
    const m = {
      type: 'assistant', uuid: 'U', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }, { type: 'text', text: 'b' }] },
    };
    expect(map(m)).toEqual([
      { t: 'message', id: 'U:0', text: 'a' },
      { t: 'tool-call', id: 'tu1', name: 'Bash', input: { command: 'ls' }, sub: false },
      { t: 'message', id: 'U:2', text: 'b' },
    ]);
  });

  it('assistant of a sub-agent: no text, tool-call with sub true', () => {
    const m = {
      type: 'assistant', uuid: 'U', parent_tool_use_id: 'P',
      message: { content: [{ type: 'text', text: 'hidden' }, { type: 'tool_use', id: 'tu2', name: 'Read' }] },
    };
    expect(map(m)).toEqual([{ t: 'tool-call', id: 'tu2', name: 'Read', input: {}, sub: true }]);
  });

  it('assistant with a string content or thinking blocks -> nothing', () => {
    expect(map({ type: 'assistant', uuid: 'U', message: { content: 'x' } })).toEqual([]);
    expect(map({ type: 'assistant', uuid: 'U', message: { content: [{ type: 'thinking', thinking: 'z' }] } })).toEqual([]);
  });
});

describe('mapSdk: tool results', () => {
  const user = (content: unknown[]) => ({ type: 'user', message: { content } });
  it('string content', () => {
    expect(map(user([{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }]))).toEqual([{ t: 'tool-update', id: 'a', text: 'ok', isError: false }]);
  });
  it('block content: text joined, images as [image], other types as [type]; is_error', () => {
    const c = [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'tool_reference' }];
    expect(map(user([{ type: 'tool_result', tool_use_id: 'a', content: c, is_error: true }])))
      .toEqual([{ t: 'tool-update', id: 'a', text: 'x\n[image]\n[tool_reference]', isError: true }]);
  });
  it('missing content -> empty text; several results -> several events; non-result blocks skipped', () => {
    expect(map(user([{ type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 'a' }, { type: 'tool_result', tool_use_id: 'b', content: 'y' }])))
      .toEqual([{ t: 'tool-update', id: 'a', text: '', isError: false }, { t: 'tool-update', id: 'b', text: 'y', isError: false }]);
  });
});

describe('mapSdk: result -> turn-end', () => {
  const end = (m: object) => map({ type: 'result', duration_ms: 1600, ...m })[0] as Extract<AgentEvent, { t: 'turn-end' }>;
  it('rounds secs, names the answered sends, reports queued', () => {
    expect(end({ subtype: 'success', is_error: false, user_message_uuids: ['a', 'b'], queued_turn_count: 2 }))
      .toEqual({ t: 'turn-end', stop: 'done', secs: 2, answers: ['a', 'b'], queued: 2 });
  });
  it('single user_message_uuid', () => {
    expect(end({ subtype: 'success', user_message_uuid: 'a' }).answers).toEqual(['a']);
  });
  it('no names: success -> none, error -> all', () => {
    expect(end({ subtype: 'success' }).answers).toBe('none');
    expect(end({ subtype: 'success', is_error: true, result: 'boom' }).answers).toBe('all');
  });
  it('an error that names sends answers only them', () => {
    expect(end({ subtype: 'success', is_error: true, result: 'boom', user_message_uuids: ['a'] }).answers).toEqual(['a']);
  });
  it('terminal_reason aborted* -> interrupted (even with is_error)', () => {
    expect(end({ subtype: 'success', terminal_reason: 'aborted_streaming' }).stop).toBe('interrupted');
    expect(end({ subtype: 'success', is_error: true, terminal_reason: 'aborted_tools', result: 'x' })).not.toHaveProperty('error');
  });
  it('error_during_execution without is_error -> interrupted; with is_error -> failed', () => {
    expect(end({ subtype: 'error_during_execution', is_error: false }).stop).toBe('interrupted');
    expect(end({ subtype: 'error_during_execution', is_error: true }).stop).toBe('failed');
  });
  it('non-success subtype -> failed; error text from errors[] (strings only, joined)', () => {
    expect(end({ subtype: 'error_max_turns', errors: ['one', 2, 'two'] })).toMatchObject({ stop: 'failed', error: 'one\ntwo' });
  });
  it('the text of result wins over errors[]; no text -> no error key', () => {
    expect(end({ subtype: 'success', is_error: true, result: 'r', errors: ['e'] }).error).toBe('r');
    expect(end({ subtype: 'success', is_error: true })).not.toHaveProperty('error');
  });
  it('a missing duration is 0 s; a missing subtype with no is_error is done', () => {
    expect(map({ type: 'result' })[0]).toMatchObject({ stop: 'done', secs: 0, queued: 0, answers: 'none' });
  });
});

describe('mapSdk: commands, compaction, reset, mode', () => {
  it('command_lifecycle cancelled -> cancelled; without a command_uuid -> nothing', () => {
    expect(map({ type: 'command_lifecycle', state: 'cancelled', command_uuid: 'c' })).toEqual([{ t: 'cancelled', sendId: 'c' }]);
    expect(map({ type: 'command_lifecycle', state: 'cancelled' })).toEqual([]);
  });
  it('status compacting', () => {
    expect(map({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([{ t: 'compacting' }]);
  });
  it('status null with compact_result failed -> compact-failed (with / without the text)', () => {
    expect(map({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'too big' })).toEqual([{ t: 'compact-failed', error: 'too big' }]);
    expect(map({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' })).toEqual([{ t: 'compact-failed' }]);
  });
  it('a bare status null (success or none) -> compact-end; the boundary may follow', () => {
    expect(map({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })).toEqual([{ t: 'compact-end' }]);
    expect(map({ type: 'system', subtype: 'status', status: null })).toEqual([{ t: 'compact-end' }]);
  });
  it('other status values -> nothing', () => {
    expect(map({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([]);
  });
  it('status carrying permissionMode -> mode; an unknown mode is ignored', () => {
    expect(map({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' })).toEqual([{ t: 'mode', mode: 'plan' }]);
    expect(map({ type: 'system', subtype: 'status', status: null, permissionMode: 'bypass' })).toEqual([]);
  });
  it('status compacting with a permissionMode gives both, compacting last', () => {
    expect(map({ type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'default' })).toEqual([{ t: 'mode', mode: 'default' }, { t: 'compacting' }]);
  });
  it('init without optional fields; an invalid mode is dropped', () => {
    expect(map({ type: 'system', subtype: 'init', permissionMode: 'weird' })).toEqual([{ t: 'init' }]);
  });
  it('compact_boundary -> compacted with preTokens and ms (ms only when non-zero)', () => {
    expect(map({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 9000, duration_ms: 4200 } })).toEqual([{ t: 'compacted', preTokens: 9000, ms: 4200 }]);
    expect(map({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 9000, duration_ms: 0 } })).toEqual([{ t: 'compacted', preTokens: 9000 }]);
    expect(map({ type: 'system', subtype: 'compact_boundary' })).toEqual([{ t: 'compacted', preTokens: 0 }]);
  });
  it('conversation_reset in both shapes', () => {
    expect(map({ type: 'conversation_reset', new_conversation_id: 'N' })).toEqual([{ t: 'reset', newId: 'N' }]);
    expect(map({ type: 'system', subtype: 'conversation_reset', new_conversation_id: 'N' })).toEqual([{ t: 'reset', newId: 'N' }]);
    expect(map({ type: 'conversation_reset' })).toEqual([{ t: 'reset' }]);
    expect(map({ type: 'system', subtype: 'conversation_reset', new_conversation_id: 7 })).toEqual([{ t: 'reset' }]);
  });
});

describe('mapSdk: tasks, suggestion, rate limit', () => {
  const sys = (subtype: string, rest: object) => map({ type: 'system', subtype, ...rest });
  it('task_started: description, else subagent_type, task_type, "task"', () => {
    expect(sys('task_started', { task_id: 't', description: 'D', task_type: 'local_agent' })).toEqual([{ t: 'task', id: 't', phase: 'started', desc: 'D', type: 'local_agent' }]);
    expect(sys('task_started', { task_id: 't', subagent_type: 'Explore' })[0]).toMatchObject({ desc: 'Explore', type: '' });
    expect(sys('task_started', { task_id: 't', task_type: 'bash' })[0]).toMatchObject({ desc: 'bash', type: 'bash' });
    expect(sys('task_started', { task_id: 't' })[0]).toMatchObject({ desc: 'task' });
  });
  it('task_started ambient or skip_transcript -> nothing; no task_id -> nothing', () => {
    expect(sys('task_started', { task_id: 't', ambient: true })).toEqual([]);
    expect(sys('task_started', { task_id: 't', skip_transcript: true })).toEqual([]);
    expect(sys('task_started', {})).toEqual([]);
  });
  it('task_progress', () => {
    expect(sys('task_progress', { task_id: 't', usage: { total_tokens: 5 }, last_tool_name: 'Grep', summary: 's' }))
      .toEqual([{ t: 'task', id: 't', phase: 'progress', tokens: 5, tool: 'Grep', summary: 's' }]);
    expect(sys('task_progress', { task_id: 't' })).toEqual([{ t: 'task', id: 't', phase: 'progress', tokens: 0, tool: '', summary: '' }]);
  });
  it('task_updated: live status with a description -> updated; terminal status -> done; nothing to say -> nothing', () => {
    expect(sys('task_updated', { task_id: 't', patch: { description: 'new' } })).toEqual([{ t: 'task', id: 't', phase: 'updated', desc: 'new' }]);
    expect(sys('task_updated', { task_id: 't', patch: { status: 'running', description: 'new' } })[0]).toMatchObject({ phase: 'updated', desc: 'new' });
    expect(sys('task_updated', { task_id: 't', patch: { status: 'completed' } })).toEqual([{ t: 'task', id: 't', phase: 'done' }]);
    expect(sys('task_updated', { task_id: 't', patch: { status: 'killed', description: 'x' } })).toEqual([{ t: 'task', id: 't', phase: 'done' }]);
    expect(sys('task_updated', { task_id: 't', patch: { status: 'paused' } })).toEqual([]);
  });
  it('task_notification -> done', () => {
    expect(sys('task_notification', { task_id: 't', status: 'completed' })).toEqual([{ t: 'task', id: 't', phase: 'done' }]);
  });
  it('prompt_suggestion -> trimmed suggestion; non-string -> nothing', () => {
    expect(map({ type: 'prompt_suggestion', suggestion: '  run the tests \n' })).toEqual([{ t: 'suggestion', text: 'run the tests' }]);
    expect(map({ type: 'prompt_suggestion' })).toEqual([]);
  });
  it('rate_limit_event -> rate-limit with its info; without info -> nothing', () => {
    const info = { status: 'allowed', resetsAt: 1 };
    expect(map({ type: 'rate_limit_event', rate_limit_info: info })).toEqual([{ t: 'rate-limit', info }]);
    expect(map({ type: 'rate_limit_event' })).toEqual([]);
  });
  it('unknown frames -> nothing', () => {
    expect(map({ type: 'tool_progress' })).toEqual([]);
    expect(map({ type: 'system', subtype: 'hook_started' })).toEqual([]);
    expect(map({})).toEqual([]);
  });
});
