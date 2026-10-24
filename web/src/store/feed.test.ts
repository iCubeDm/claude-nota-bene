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
  const s1 = fold([user(), user({ id: 'u2', force: true }), result({ subtype: 'error_during_execution', is_error: true, result: '' })]);
  expect(s1.busy).toBe(true);
  expect(s1.forcePending).toBe(false);
  expect(s1.items.at(-1)).toEqual({ kind: 'done', secs: 2, ts: 99, interrupted: true });
  const s2 = reduce(s1, result());
  expect(s2.busy).toBe(false);
  expect(s2.items.at(-1)).toMatchObject({ interrupted: false });
});

test('tool_result is_error marks the tool red', () => {
  const s = fold([
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls\nmore' } }]),
    sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }),
  ]);
  expect(s.items).toEqual([{ kind: 'tool', id: 't1', name: 'Bash', arg: 'ls', sub: false, error: true }]);
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
  expect(s.items).toEqual([{ kind: 'tool', id: 't2', name: 'Read', arg: '/a', sub: true }]);
});

test('session only sets the session; the resumed marker alone adds the notice; server-error, immutability', () => {
  const frozen = Object.freeze({ ...emptyFeed, items: Object.freeze([]) as never });
  expect(reduce(frozen, { kind: 'session', id: 'abcdefghij', root: '/r' })).toMatchObject({ items: [], session: { id: 'abcdefghij', root: '/r' } });
  const withItem = fold([user()]);
  Object.freeze(withItem); Object.freeze(withItem.items);
  // the CLI sends init (-> session) every turn: it must never add a notice
  expect(reduce(withItem, { kind: 'session', id: 'abcdefghij', root: '/r' }).items).toEqual(withItem.items);
  expect(reduce(withItem, { kind: 'resumed', id: 'abcdefghij' }).items.at(-1)).toEqual({ kind: 'notice', text: 'abcdefgh' });
  expect(reduce(frozen, { kind: 'resumed', id: 'abcdefghij' }).items).toEqual([{ kind: 'notice', text: 'abcdefgh' }]);
  expect(reduce(withItem, { kind: 'server-error', where: 'w', message: 'm' })).toBe(withItem);
  expect(() => reduce(withItem, start())).not.toThrow();
  expect(() => reduce(withItem, result())).not.toThrow();
});

test('a conversation with init every turn shows no notice; replayed history plus marker shows exactly one', () => {
  const init = (id: string) => sdk({ type: 'system', subtype: 'init', session_id: id });
  const session = (id: string): ServerEvent => ({ kind: 'session', id, root: '/r' });
  const live = fold([session('s1'), user(), init('s1'), result(), user({ id: 'u2' }), init('s1'), session('s1'), result()]);
  expect(live.items.some((i) => i.kind === 'notice')).toBe(false);
  const resumed = reduce(emptyFeed, { kind: 'replay', events: [user({ historic: true }), { kind: 'resumed', id: 's1' }, session('s1')] });
  const after = fold([user({ id: 'u3' }), init('s1'), result()], resumed);
  expect(after.items.filter((i) => i.kind === 'notice')).toHaveLength(1);
});

test('interrupted stream is closed at result; a later assistant without a start stays separate', () => {
  const s = fold([
    user(), start(), delta('part'),
    result({ subtype: 'error_during_execution', is_error: true, result: '' }),
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
  expect(reduce(emptyFeed, { kind: 'replay', events: [user(), result()] }).busy).toBe(false);
});
