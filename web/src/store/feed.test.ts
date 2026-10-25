import type { ServerEvent } from '@nota-bene/shared';
import { expect, test } from 'vitest';
import { emptyFeed, reduce, type FeedState } from './feed.ts';

const sdk = (m: Record<string, unknown>, ts = 1): ServerEvent => ({ kind: 'sdk', m: m as never, ts });
const start = (parent: string | null = null) =>
  sdk({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
const delta = (text: string, parent: string | null = null) =>
  sdk({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const assistant = (content: unknown[], uuid = 'a1', parent: string | null = null) =>
  sdk({ type: 'assistant', uuid, parent_tool_use_id: parent, message: { content } });
const result = (extra: Record<string, unknown> = {}) =>
  sdk({ type: 'result', subtype: 'success', duration_ms: 2400, is_error: false, result: 'ok', ...extra }, 99);
const user = (extra: Partial<Extract<ServerEvent, { kind: 'user' }>> = {}): ServerEvent => ({ kind: 'user', id: 'u1', text: 'hi', ts: 5, ...extra });
const fold = (evs: ServerEvent[], from: FeedState = emptyFeed) => evs.reduce(reduce, from);

test('deltas build one streaming item, assistant finalises it in place', () => {
  const mid = fold([start(), delta('hello '), delta('world')]);
  expect(mid.items).toEqual([{ kind: 'assistant', id: 'stream:0', text: 'hello world', final: false }]);
  const s = reduce(mid, assistant([{ type: 'text', text: 'hello world' }]));
  expect(s.items).toEqual([{ kind: 'assistant', id: 'a1:0', text: 'hello world', final: true }]);
});

test('replay mid-stream then live deltas continue the same item', () => {
  const replayed = reduce(emptyFeed, { kind: 'replay', events: [start(), delta('hel')] });
  const s = fold([delta('lo')], replayed);
  expect(s.items).toEqual([{ kind: 'assistant', id: 'stream:0', text: 'hello', final: false }]);
});

test('user while busy is marked duringWork', () => {
  const s = fold([user(), user({ id: 'u2' })]);
  expect(s.items[0]).not.toHaveProperty('duringWork');
  expect(s.items[1]).toMatchObject({ id: 'u2', duringWork: true });
  expect(fold([user({ historic: true })]).busy).toBe(false);
});

test('force keeps busy across the interrupted result; the next result clears it', () => {
  const s1 = fold([user(), user({ id: 'u2', force: true }), result({ result: '', terminal_reason: 'aborted_streaming', user_message_uuids: ['u1'] })]);
  expect(s1.busy).toBe(true);
  expect(s1.forcePending).toBe(false);
  expect(s1.items.at(-1)).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
  const s2 = reduce(s1, result({ user_message_uuids: ['u2'] }));
  expect(s2.busy).toBe(false);
  expect(s2.items.at(-1)).toMatchObject({ status: 'done' });
  // nothing left waiting: only forcePending can keep busy here
  const forced = result({ result: '', terminal_reason: 'aborted_streaming', user_message_uuids: ['u1', 'u2'] });
  const s3 = fold([user(), user({ id: 'u2', force: true }), forced]);
  expect(s3.waiting).toEqual([]);
  expect(s3.busy).toBe(true);
});

test('tool_result is_error marks the tool red', () => {
  const s = fold([
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls\nmore' } }]),
    sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }),
  ]);
  expect(s.items).toEqual([{
    kind: 'tool', id: 't1', name: 'Bash', arg: 'ls', sub: false,
    input: { command: 'ls\nmore' }, result: { text: '', isError: true },
  }]);
});

const toolUse = (id = 't1', input: Record<string, unknown> = { command: 'ls -la\necho done' }) =>
  assistant([{ type: 'tool_use', id, name: 'Bash', input }]);
const toolResult = (blocks: unknown[]) => sdk({ type: 'user', message: { content: blocks } });

test('tool item keeps the full input and gets its result by tool_use_id', () => {
  const input = { command: 'ls -la\necho done', description: 'list' };
  const s = fold([
    toolUse('t1', input), toolUse('t2', { command: 'pwd' }),
    toolResult([{ type: 'tool_result', tool_use_id: 't2', content: '/tmp' }]),
    toolResult([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }, { type: 'text', text: 'b' }, { type: 'document' }] }]),
  ]);
  expect(s.items[0]).toMatchObject({ arg: 'ls -la', input, result: { text: 'a\n[image]\nb\n[document]', isError: false } });
  expect(s.items[1]).toMatchObject({ result: { text: '/tmp', isError: false } });
});

test('an error result marks the item and keeps the text', () => {
  const s = fold([toolUse(), toolResult([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }])]);
  expect(s.items[0]).toMatchObject({ result: { text: 'boom', isError: true } });
});

test('a tool_result user message never makes a bubble; an orphan result is ignored', () => {
  const s = fold([
    toolResult([{ type: 'tool_result', tool_use_id: 'ghost', content: 'early' }]),
    toolUse(),
    toolResult([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'stray text' }]),
  ]);
  expect(s.items.map((i) => i.kind)).toEqual(['tool']);
  expect(s.items[0]).toMatchObject({ result: { text: 'ok' } });
  expect(s.busy).toBe(false);
});

test('permission-done records the answer', () => {
  const s = fold([
    { kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'x' }, ts: 1 },
    { kind: 'permission-done', id: 'p1', allow: false, ts: 2 },
  ]);
  expect(s.items).toEqual([{ kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'x' }, answer: false }]);
});

test('subagent tool lines are sub; subagent text is not added', () => {
  const s = fold([
    start('p'), delta('x', 'p'),
    assistant([{ type: 'text', text: 'sub text' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } }], 'a2', 'p'),
  ]);
  expect(s.items).toEqual([{ kind: 'tool', id: 't2', name: 'Read', arg: '/a', sub: true, input: { file_path: '/a' } }]);
});

test('session only sets the session; the resumed marker alone adds the notice; server-error, immutability', () => {
  const frozen = Object.freeze({ ...emptyFeed, items: Object.freeze([]) as never });
  expect(reduce(frozen, { kind: 'session', id: 'abcdefghij', root: '/r', title: null, model: null })).toMatchObject({ items: [], session: { id: 'abcdefghij', root: '/r' } });
  const withItem = fold([user()]);
  Object.freeze(withItem); Object.freeze(withItem.items);
  // the CLI sends init (-> session) every turn: it must never add a notice
  expect(reduce(withItem, { kind: 'session', id: 'abcdefghij', root: '/r', title: null, model: null }).items).toEqual(withItem.items);
  expect(reduce(withItem, { kind: 'resumed', id: 'abcdefghij' }).items.at(-1)).toEqual({ kind: 'notice', text: 'abcdefgh' });
  expect(reduce(frozen, { kind: 'resumed', id: 'abcdefghij' }).items).toEqual([{ kind: 'notice', text: 'abcdefgh' }]);
  const err = reduce(withItem, { kind: 'server-error', where: 'comments', message: 'EACCES' });
  expect(err.items.at(-1)).toEqual({ kind: 'notice', text: 'EACCES', tone: 'error', where: 'comments' });
  expect(err.items.slice(0, -1)).toEqual(withItem.items);
  expect(() => reduce(withItem, start())).not.toThrow();
  expect(() => reduce(withItem, result())).not.toThrow();
});

test('a conversation with init every turn shows no notice; replayed history plus marker shows exactly one', () => {
  const init = (id: string) => sdk({ type: 'system', subtype: 'init', session_id: id });
  const session = (id: string): ServerEvent => ({ kind: 'session', id, root: '/r', title: null, model: null });
  const live = fold([session('s1'), user(), init('s1'), result(), user({ id: 'u2' }), init('s1'), session('s1'), result()]);
  expect(live.items.some((i) => i.kind === 'notice')).toBe(false);
  const resumed = reduce(emptyFeed, { kind: 'replay', events: [user({ historic: true }), { kind: 'resumed', id: 's1' }, session('s1')] });
  const after = fold([user({ id: 'u3' }), init('s1'), result()], resumed);
  expect(after.items.filter((i) => i.kind === 'notice')).toHaveLength(1);
});

test('interrupted stream is closed at result; a later assistant without a start stays separate', () => {
  const s = fold([
    user(), start(), delta('part'),
    result({ result: '', terminal_reason: 'aborted_streaming' }),
    user({ id: 'u2' }),
    assistant([{ type: 'text', text: 'fresh' }], 'a9'),
  ]);
  const asst = s.items.filter((i) => i.kind === 'assistant');
  expect(asst).toEqual([
    { kind: 'assistant', id: 'stream:0', text: 'part', final: true },
    { kind: 'assistant', id: 'a9:0', text: 'fresh', final: true },
  ]);
  expect(s.items.findIndex((i) => i.kind === 'user' && i.id === 'u2')).toBeGreaterThan(s.items.findIndex((i) => i.kind === 'assistant'));
  const empty = fold([user(), start(), result()]);
  expect(empty.items.some((i) => i.kind === 'assistant')).toBe(false);
});

test('two streamed text blocks are finalised in content order', () => {
  const s = fold([
    start(), delta('one'), start(), delta('two'),
    assistant([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 'a3'),
  ]);
  expect(s.items).toEqual([
    { kind: 'assistant', id: 'a3:0', text: 'one', final: true },
    { kind: 'assistant', id: 'a3:1', text: 'two', final: true },
  ]);
});

test('replay keeps the folded busy: mid-turn history is busy, finished is not', () => {
  expect(reduce(emptyFeed, { kind: 'replay', events: [user()] }).busy).toBe(true);
  expect(reduce(emptyFeed, { kind: 'replay', events: [user(), result({ user_message_uuids: ['u1'] })] }).busy).toBe(false);
});

const lastDone = (s: FeedState) => s.items.filter((i) => i.kind === 'done').at(-1);

test('interrupt results: the CLI ends the turn with subtype success and an aborted terminal_reason', () => {
  expect(lastDone(fold([user(), result({ result: '', terminal_reason: 'aborted_streaming' })]))).toMatchObject({ status: 'interrupted' });
  expect(lastDone(fold([user(), result({ result: '', terminal_reason: 'aborted_tools' })]))).toMatchObject({ status: 'interrupted' });
  expect(lastDone(fold([user(), result({ subtype: 'error_during_execution', is_error: false, errors: [] })]))).toMatchObject({ status: 'interrupted' });
  expect(lastDone(fold([user(), result({ terminal_reason: 'completed' })]))).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'done' });
});

test('error results show their text; a crash is an error, not an interruption', () => {
  const crash = lastDone(fold([user(), result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['agent session ended'] })]));
  expect(crash).toMatchObject({ status: 'failed', error: 'agent session ended' });
  const two = lastDone(fold([user(), result({ subtype: 'error_max_turns', is_error: true, result: undefined, errors: ['a', 'b'] })]));
  expect(two).toMatchObject({ status: 'failed', error: 'a\nb' });
  const api = lastDone(fold([user(), result({ is_error: true, result: 'API Error: 500', terminal_reason: 'api_error' })]));
  expect(api).toMatchObject({ status: 'failed', error: 'API Error: 500' });
  const bare = lastDone(fold([user(), result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined, errors: [] })]));
  expect(bare).toMatchObject({ status: 'failed' });
  expect(bare).not.toHaveProperty('error');
});

test('a result with queued_turn_count > 0 keeps busy until the queued turn ends', () => {
  const s1 = fold([user(), user({ id: 'u2' }), result({ queued_turn_count: 1, user_message_uuids: ['u1', 'u2'] })]);
  expect(s1.busy).toBe(true);
  expect(lastDone(s1)).toMatchObject({ status: 'done' });
  expect(reduce(s1, result({ queued_turn_count: 0 })).busy).toBe(false);
  expect(fold([user(), result({ user_message_uuids: ['u1'] })]).busy).toBe(false); // absent counts as 0
});

test('busy follows unanswered sends: a result answers the sends named in user_message_uuids', () => {
  // the real CLI reports queued_turn_count 0 even with a send queued, so busy cannot rely on it
  const s1 = fold([user(), user({ id: 'u2' }), result({ queued_turn_count: 0, user_message_uuids: ['u1'] })]);
  expect(s1.busy).toBe(true);
  expect(reduce(s1, result({ user_message_uuids: ['u2'] })).busy).toBe(false);
  // one turn may consume several sends
  expect(fold([user(), user({ id: 'u2' }), result({ user_message_uuids: ['u1', 'u2'] })]).busy).toBe(false);
  // fallback without the list: user_message_uuid; an error result naming nothing (crash) answers every waiting send; a success naming nothing answers none
  expect(fold([user(), user({ id: 'u2' }), result({ user_message_uuid: 'u2' })]).busy).toBe(true);
  expect(fold([user(), user({ id: 'u2' }), result({ user_message_uuid: 'u2' }), result({ user_message_uuid: 'u1' })]).busy).toBe(false);
  // historic (transcript) sends are never waited for
  expect(fold([user({ historic: true }), user({ id: 'u2' }), result({ user_message_uuids: ['u2'] })]).busy).toBe(false);
});

test('a uuid-less result (crash) clears every waiting send, not just the oldest', () => {
  const s = fold([user(), user({ id: 'u2' }), sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, errors: ['boom'] })]);
  expect(s.waiting).toEqual([]);
  expect(s.busy).toBe(false);
});

test('a uuid-less SUCCESS result (task-notification turn) answers no send; a uuid-less error result answers all', () => {
  const s = fold([user(), result()]);
  expect(s.busy).toBe(true);
  expect(s.waiting).toEqual(['u1']);
  const e = reduce(s, sdk({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, errors: ['x'] }));
  expect(e.waiting).toEqual([]);
  expect(e.busy).toBe(false);
});

test('command_lifecycle cancelled removes that send from waiting', () => {
  const s1 = fold([user()]);
  expect(s1.busy).toBe(true);
  const s2 = reduce(s1, sdk({ type: 'command_lifecycle', command_uuid: 'u1', state: 'cancelled' }));
  expect(s2.waiting).toEqual([]);
  expect(s2.busy).toBe(false);
  // other states and other ids change nothing
  expect(reduce(s1, sdk({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' }))).toBe(s1);
  expect(reduce(s1, sdk({ type: 'command_lifecycle', command_uuid: 'zz', state: 'cancelled' })).waiting).toEqual(['u1']);
});

test('turnSeq counts live results only; a replay keeps the live counter', () => {
  const res = { kind: 'sdk', ts: 1, m: { type: 'result', subtype: 'success', duration_ms: 1 } } as unknown as ServerEvent;
  let s = reduce(emptyFeed, res);
  expect(s.turnSeq).toBe(1);
  s = reduce(s, { kind: 'replay', events: [res, res] });
  expect(s.turnSeq).toBe(1);
  expect(reduce(s, res).turnSeq).toBe(2);
});

test('a live reset frame empties the feed and adds the cleared line, keeping the session', () => {
  const s0 = fold([{ kind: 'session', id: 'old', root: '/r', title: null, model: null }, user(), result()]);
  expect(s0.items.length).toBe(2);
  const s = fold([sdk({ type: 'conversation_reset', new_conversation_id: 'new' }, 7)], s0);
  expect(s.items).toEqual([{ kind: 'marker', what: 'cleared', ts: 7 }]);
  expect(s.busy).toBe(false);
  expect(s.session).toEqual({ id: 'old', root: '/r', title: null, model: null }); // the session event that follows updates it
});

test('a replay of the new session carries no cleared line', () => {
  expect(reduce(emptyFeed, { kind: 'replay', events: [] }).items).toEqual([]);
});

test('compact_boundary adds a compacted line, live or replayed', () => {
  const cb = sdk({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12345 } }, 9);
  const want = [{ kind: 'marker', what: 'compacted', pre: 12345, ts: 9 }];
  expect(fold([cb]).items).toEqual(want);
  expect(reduce(emptyFeed, { kind: 'replay', events: [cb] }).items).toEqual(want);
});
