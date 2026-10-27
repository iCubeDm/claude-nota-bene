import type { ServerEvent, WireAgentEvent } from '@nota-bene/shared';
import { expect, test } from 'vitest';
import { emptyFeed, reduce, type FeedState } from './feed.ts';

type Turn = Extract<WireAgentEvent, { t: 'turn-end' }>;
const agent = (e: WireAgentEvent, ts = 1): ServerEvent => ({ kind: 'agent', e, ts });
const start = () => agent({ t: 'message-start' });
const delta = (text: string) => agent({ t: 'message-chunk', text });
const message = (id: string, text: string) => agent({ t: 'message', id, text });
const result = (extra: Partial<Turn> = {}) =>
  agent({ t: 'turn-end', stop: 'done', secs: 2, answers: 'none', queued: 0, ...extra }, 99);
const toolUse = (id = 't1', input: Record<string, unknown> = { command: 'ls -la\necho done' }, sub = false) =>
  agent({ t: 'tool-call', id, name: 'Bash', input, sub });
const toolResult = (id: string, text: string, isError = false) => agent({ t: 'tool-update', id, text, isError });
const user = (extra: Partial<Extract<ServerEvent, { kind: 'user' }>> = {}): ServerEvent => ({ kind: 'user', id: 'u1', text: 'hi', ts: 5, ...extra });
const fold = (evs: ServerEvent[], from: FeedState = emptyFeed) => evs.reduce(reduce, from);

test('deltas build one streaming item, assistant finalises it in place', () => {
  const mid = fold([start(), delta('hello '), delta('world')]);
  expect(mid.items).toEqual([{ kind: 'assistant', id: 'stream:0', text: 'hello world', final: false }]);
  const s = reduce(mid, message('a1:0', 'hello world'));
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
  const s1 = fold([user(), user({ id: 'u2', force: true }), result({ stop: 'interrupted', answers: ['u1'] })]);
  expect(s1.busy).toBe(true);
  expect(s1.forcePending).toBe(false);
  expect(s1.items.at(-1)).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
  const s2 = reduce(s1, result({ answers: ['u2'] }));
  expect(s2.busy).toBe(false);
  expect(s2.items.at(-1)).toMatchObject({ status: 'done' });
  // nothing left waiting: only forcePending can keep busy here
  const forced = result({ stop: 'interrupted', answers: ['u1', 'u2'] });
  const s3 = fold([user(), user({ id: 'u2', force: true }), forced]);
  expect(s3.waiting).toEqual([]);
  expect(s3.busy).toBe(true);
});

test('while a forced send is pending, any turn-end shows as interrupted, with no error text (R-M7-14)', () => {
  const forced = fold([user(), user({ id: 'u2', force: true })]);
  expect(reduce(forced, result({ stop: 'done', answers: ['u1'] })).items.at(-1)).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
  expect(reduce(forced, result({ stop: 'failed', error: 'boom', answers: ['u1'] })).items.at(-1)).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
});

test('tool_result is_error marks the tool red', () => {
  const s = fold([toolUse('t1', { command: 'ls\nmore' }), toolResult('t1', '', true)]);
  expect(s.items).toEqual([{
    kind: 'tool', id: 't1', name: 'Bash', arg: 'ls', sub: false,
    input: { command: 'ls\nmore' }, result: { text: '', isError: true },
  }]);
});

test('tool item keeps the full input and gets its result by tool_use_id', () => {
  const input = { command: 'ls -la\necho done', description: 'list' };
  const s = fold([
    toolUse('t1', input), toolUse('t2', { command: 'pwd' }),
    toolResult('t2', '/tmp'),
    toolResult('t1', 'a\n[image]\nb\n[document]'), // the joining of result blocks is the mapper's (map.test.ts)
  ]);
  expect(s.items[0]).toMatchObject({ arg: 'ls -la', input, result: { text: 'a\n[image]\nb\n[document]', isError: false } });
  expect(s.items[1]).toMatchObject({ result: { text: '/tmp', isError: false } });
});

test('an error result marks the item and keeps the text', () => {
  const s = fold([toolUse(), toolResult('t1', 'boom', true)]);
  expect(s.items[0]).toMatchObject({ result: { text: 'boom', isError: true } });
});

test('a tool result never makes a bubble; a result for an unknown tool id is ignored', () => {
  const s = fold([toolResult('ghost', 'early'), toolUse(), toolResult('t1', 'ok')]);
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

// that a sub-agent's text never becomes an event is the mapper's (map.test.ts)
test('subagent tool lines are sub', () => {
  const s = fold([agent({ t: 'tool-call', id: 't2', name: 'Read', input: { file_path: '/a' }, sub: true })]);
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
  // a server error is a toast (R-M4-5): the feed is untouched
  expect(reduce(withItem, { kind: 'server-error', where: 'comments', message: 'EACCES' }).items).toEqual(withItem.items);
  expect(() => reduce(withItem, start())).not.toThrow();
  expect(() => reduce(withItem, result())).not.toThrow();
});

// the CLI's init every turn is server-internal (never sent); the server re-announces `session` instead
test('a conversation with session every turn shows no notice; replayed history plus marker shows exactly one', () => {
  const session = (id: string): ServerEvent => ({ kind: 'session', id, root: '/r', title: null, model: null });
  const live = fold([session('s1'), user(), session('s1'), result(), user({ id: 'u2' }), session('s1'), result()]);
  expect(live.items.some((i) => i.kind === 'notice')).toBe(false);
  const resumed = reduce(emptyFeed, { kind: 'replay', events: [user({ historic: true }), { kind: 'resumed', id: 's1' }, session('s1')] });
  const after = fold([user({ id: 'u3' }), session('s1'), result()], resumed);
  expect(after.items.filter((i) => i.kind === 'notice')).toHaveLength(1);
});

test('interrupted stream is closed at result; a later assistant without a start stays separate', () => {
  const s = fold([
    user(), start(), delta('part'),
    result({ stop: 'interrupted' }),
    user({ id: 'u2' }),
    message('a9:0', 'fresh'),
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
    message('a3:0', 'one'), message('a3:1', 'two'),
  ]);
  expect(s.items).toEqual([
    { kind: 'assistant', id: 'a3:0', text: 'one', final: true },
    { kind: 'assistant', id: 'a3:1', text: 'two', final: true },
  ]);
});

test('replay keeps the folded busy: mid-turn history is busy, finished is not', () => {
  expect(reduce(emptyFeed, { kind: 'replay', events: [user()] }).busy).toBe(true);
  expect(reduce(emptyFeed, { kind: 'replay', events: [user(), result({ answers: ['u1'] })] }).busy).toBe(false);
});

const lastDone = (s: FeedState) => s.items.filter((i) => i.kind === 'done').at(-1);

// which CLI results are interruptions (aborted terminal_reason, error_during_execution without is_error) is the mapper's (map.test.ts)
test('the turn-end stop becomes the done line status', () => {
  expect(lastDone(fold([user(), result({ stop: 'interrupted' })]))).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
  expect(lastDone(fold([user(), result()]))).toEqual({ kind: 'done', secs: 2, ts: 99, status: 'done' });
});

// where the error text comes from (result, errors[] joined) is the mapper's (map.test.ts)
test('failed turns show their error text; one without text has no error key', () => {
  const crash = lastDone(fold([user(), result({ stop: 'failed', error: 'agent session ended', answers: 'all' })]));
  expect(crash).toMatchObject({ status: 'failed', error: 'agent session ended' });
  const two = lastDone(fold([user(), result({ stop: 'failed', error: 'a\nb' })]));
  expect(two).toMatchObject({ status: 'failed', error: 'a\nb' });
  const bare = lastDone(fold([user(), result({ stop: 'failed' })]));
  expect(bare).toMatchObject({ status: 'failed' });
  expect(bare).not.toHaveProperty('error');
});

test('a turn-end with queued > 0 keeps busy until the queued turn ends', () => {
  const s1 = fold([user(), user({ id: 'u2' }), result({ queued: 1, answers: ['u1', 'u2'] })]);
  expect(s1.busy).toBe(true);
  expect(lastDone(s1)).toMatchObject({ status: 'done' });
  expect(reduce(s1, result({ queued: 0 })).busy).toBe(false);
  expect(fold([user(), result({ answers: ['u1'] })]).busy).toBe(false);
});

test('busy follows unanswered sends: a turn-end answers the sends it names', () => {
  // the real CLI reports queued_turn_count 0 even with a send queued, so busy cannot rely on it
  const s1 = fold([user(), user({ id: 'u2' }), result({ queued: 0, answers: ['u1'] })]);
  expect(s1.busy).toBe(true);
  expect(reduce(s1, result({ answers: ['u2'] })).busy).toBe(false);
  // one turn may consume several sends
  expect(fold([user(), user({ id: 'u2' }), result({ answers: ['u1', 'u2'] })]).busy).toBe(false);
  // answered out of order (the single user_message_uuid fallback is the mapper's, map.test.ts)
  expect(fold([user(), user({ id: 'u2' }), result({ answers: ['u2'] })]).busy).toBe(true);
  expect(fold([user(), user({ id: 'u2' }), result({ answers: ['u2'] }), result({ answers: ['u1'] })]).busy).toBe(false);
  // historic (transcript) sends are never waited for
  expect(fold([user({ historic: true }), user({ id: 'u2' }), result({ answers: ['u2'] })]).busy).toBe(false);
});

test('a turn-end answering all (a crash) clears every waiting send, not just the oldest', () => {
  const s = fold([user(), user({ id: 'u2' }), result({ stop: 'failed', secs: 0, error: 'boom', answers: 'all' })]);
  expect(s.waiting).toEqual([]);
  expect(s.busy).toBe(false);
});

test('a turn-end answering none (task-notification turn) keeps every send waiting; one answering all clears them', () => {
  const s = fold([user(), result()]);
  expect(s.busy).toBe(true);
  expect(s.waiting).toEqual(['u1']);
  const e = reduce(s, result({ stop: 'failed', secs: 0, error: 'x', answers: 'all' }));
  expect(e.waiting).toEqual([]);
  expect(e.busy).toBe(false);
});

// that only command_lifecycle `cancelled` becomes an event is the mapper's (map.test.ts)
test('cancelled removes that send from waiting', () => {
  const s1 = fold([user()]);
  expect(s1.busy).toBe(true);
  const s2 = reduce(s1, agent({ t: 'cancelled', sendId: 'u1' }));
  expect(s2.waiting).toEqual([]);
  expect(s2.busy).toBe(false);
  // other ids change nothing
  expect(reduce(s1, agent({ t: 'cancelled', sendId: 'zz' }))).toBe(s1);
  expect(reduce(s1, agent({ t: 'cancelled', sendId: 'zz' })).waiting).toEqual(['u1']);
});

test('turnSeq counts live results only; a replay keeps the live counter', () => {
  const res = result();
  let s = reduce(emptyFeed, res);
  expect(s.turnSeq).toBe(1);
  s = reduce(s, { kind: 'replay', events: [res, res] });
  expect(s.turnSeq).toBe(1);
  expect(reduce(s, res).turnSeq).toBe(2);
});

test('a live reset frame empties the feed and adds the cleared line, keeping the session', () => {
  const s0 = fold([{ kind: 'session', id: 'old', root: '/r', title: null, model: null }, user(), result()]);
  expect(s0.items.length).toBe(2);
  const s = fold([agent({ t: 'reset', newId: 'new' }, 7)], s0);
  expect(s.items).toEqual([{ kind: 'marker', what: 'cleared', ts: 7 }]);
  expect(s.busy).toBe(false);
  expect(s.session).toEqual({ id: 'old', root: '/r', title: null, model: null }); // the session event that follows updates it
});

test('a replay of the new session carries no cleared line', () => {
  expect(reduce(emptyFeed, { kind: 'replay', events: [] }).items).toEqual([]);
});

test('compacted adds a compacted line, live or replayed', () => {
  const cb = agent({ t: 'compacted', preTokens: 12345 }, 9);
  const want = [{ kind: 'marker', what: 'compacted', pre: 12345, ts: 9 }];
  expect(fold([cb]).items).toEqual(want);
  expect(reduce(emptyFeed, { kind: 'replay', events: [cb] }).items).toEqual(want);
});

const compacting = (ts = 1) => agent({ t: 'compacting' }, ts);

test('the CLI repeats compacting while it compacts (every 30 s, and per phase): the elapsed time keeps its start', () => {
  expect(fold([compacting(20), compacting(30_020), compacting(60_020)]).compacting).toBe(20);
});

test('a compaction shows while it runs: compacting to compact-end, then compacted with its duration', () => {
  const running = fold([compacting(20)]);
  expect(running.compacting).toBe(20);
  expect(running.items).toEqual([]);
  const ended = fold([
    agent({ t: 'compact-end' }, 80),
    agent({ t: 'compacted', preTokens: 900000, ms: 61000 }, 80),
  ], running);
  expect(ended.compacting).toBeNull();
  expect(ended.items).toEqual([{ kind: 'marker', what: 'compacted', pre: 900000, ms: 61000, ts: 80 }]);
});

test('a reload mid-compaction keeps its start time; a failed one leaves its error line', () => {
  const replayed = reduce(emptyFeed, { kind: 'replay', events: [user(), compacting(20)] });
  expect(replayed.compacting).toBe(20);
  const failed = reduce(replayed, agent({ t: 'compact-failed', error: 'prompt too long' }, 30));
  expect(failed.compacting).toBeNull();
  expect(failed.items.at(-1)).toEqual({ kind: 'marker', what: 'compactFailed', error: 'prompt too long', ts: 30 });
});

// other status values map to nothing (map.test.ts); a mode-only status maps to `mode` alone, so it no longer ends a compaction
test('other events leave the compaction alone; a failure without one adds nothing; a turn-end or a clear ends a stuck one', () => {
  const running = fold([compacting(20)]);
  expect(reduce(running, agent({ t: 'mode', mode: 'plan' })).compacting).toBe(20);
  expect(reduce(running, agent({ t: 'suggestion', text: 'x' })).compacting).toBe(20);
  expect(reduce(emptyFeed, agent({ t: 'compact-failed' })).items).toEqual([]); // no compaction was shown
  expect(reduce(emptyFeed, agent({ t: 'compact-end' }))).toBe(emptyFeed);
  expect(reduce(running, agent({ t: 'compact-end' })).compacting).toBeNull();
  expect(reduce(running, result()).compacting).toBeNull();
  expect(reduce(running, agent({ t: 'reset', newId: 'n' })).compacting).toBeNull();
});

test('the live result that follows a clear adds no done line; one after a new message does', () => {
  const s0 = fold([user(), result()]);
  const cleared = fold([agent({ t: 'reset', newId: 'new' }, 7), result({ secs: 0 })], s0);
  expect(cleared.items).toEqual([{ kind: 'marker', what: 'cleared', ts: 7 }]);
  expect(cleared.busy).toBe(false);
  const next = fold([user({ id: 'u2' }), result()], cleared);
  expect(next.items.map((i) => i.kind)).toEqual(['marker', 'user', 'done']);
});
