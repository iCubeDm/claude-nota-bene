import { SHELL_OUTPUT_CAP, type ServerEvent, type WireAgentEvent } from '@nota-bene/shared';
import { describe, expect, test } from 'vitest';
import { emptyFeed, prependHistory, reduce, type FeedState } from './feed.ts';

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
  expect(s1.items.at(-1)).toEqual({ key: expect.any(String), kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
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
  expect(reduce(forced, result({ stop: 'done', answers: ['u1'] })).items.at(-1)).toEqual({ key: expect.any(String), kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
  // a failure without a text is still the interrupt; with one it is a crash (the server's turn-end, M7-18) and keeps it
  expect(reduce(forced, result({ stop: 'failed', answers: ['u1'] })).items.at(-1)).toEqual({ key: expect.any(String), kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
});

test('a failed turn-end with an error text stays failed with it even while a forced send is pending (M7-18)', () => {
  const forced = fold([user(), user({ id: 'u2', force: true })]);
  const s = reduce(forced, result({ stop: 'failed', error: 'boom', answers: ['u1'] }));
  expect(s.items.at(-1)).toEqual({ key: expect.any(String), kind: 'done', secs: 2, ts: 99, status: 'failed', error: 'boom' });
});

test('line keys: unique in the live feed and across loaded segments, and they do not change when a segment is prepended', () => {
  const seg = (ts: number) => [agent({ t: 'compacted', preTokens: 1 }, ts), user({ id: `u${ts}` }), result()];
  const live = fold([...seg(1), ...seg(2)]);
  const keys = (s: FeedState) => s.items.flatMap((it) => ('key' in it ? [it.key] : []));
  const before = keys(live);
  expect(new Set(before).size).toBe(before.length);
  const p = prependHistory({ ...live, earlier: 2, session: { id: 'S', root: '/', title: null, model: null } },
    { events: seg(3), segment: 2, more: true, session: 'S', epoch: live.epoch });
  const after = keys(p);
  expect(after.slice(-before.length)).toEqual(before);
  expect(new Set(after).size).toBe(after.length);
  const p2 = prependHistory(p, { events: seg(4), segment: 1, more: false, session: 'S', epoch: live.epoch });
  expect(new Set(keys(p2)).size).toBe(keys(p2).length);
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
  expect(reduce(withItem, { kind: 'resumed', id: 'abcdefghij' }).items.at(-1)).toEqual({ key: expect.any(String), kind: 'notice', text: 'abcdefgh' });
  expect(reduce(frozen, { kind: 'resumed', id: 'abcdefghij' }).items).toEqual([{ key: expect.any(String), kind: 'notice', text: 'abcdefgh' }]);
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
  expect(lastDone(fold([user(), result({ stop: 'interrupted' })]))).toEqual({ key: expect.any(String), kind: 'done', secs: 2, ts: 99, status: 'interrupted' });
  expect(lastDone(fold([user(), result()]))).toEqual({ key: expect.any(String), kind: 'done', secs: 2, ts: 99, status: 'done' });
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

test('a crash naming the running send fails it only: the queued one keeps waiting (M7-18); an empty list answers nothing', () => {
  const two = fold([user(), user({ id: 'u2' })]);
  const s = reduce(two, result({ stop: 'failed', secs: 0, error: 'boom', answers: ['u1'] }));
  expect(s.waiting).toEqual(['u2']);
  expect(s.busy).toBe(true);
  expect(lastDone(s)).toMatchObject({ status: 'failed', error: 'boom' });
  const none = reduce(fold([user({ id: 'u2' })]), result({ stop: 'failed', secs: 0, error: 'boom', answers: [] }));
  expect(none.waiting).toEqual(['u2']);
  expect(none.busy).toBe(true);
  expect(reduce(none, result({ answers: ['u2'] })).busy).toBe(false);
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
  expect(s.items).toEqual([{ key: expect.any(String), kind: 'marker', what: 'cleared', ts: 7 }]);
  expect(s.busy).toBe(false);
  expect(s.session).toEqual({ id: 'old', root: '/r', title: null, model: null }); // the session event that follows updates it
});

test('a replay of the new session carries no cleared line', () => {
  expect(reduce(emptyFeed, { kind: 'replay', events: [] }).items).toEqual([]);
});

test('compacted adds a compacted line, live or replayed', () => {
  const cb = agent({ t: 'compacted', preTokens: 12345 }, 9);
  const want = [{ key: expect.any(String), kind: 'marker', what: 'compacted', pre: 12345, ts: 9 }];
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
  expect(ended.items).toEqual([{ key: expect.any(String), kind: 'marker', what: 'compacted', pre: 900000, ms: 61000, ts: 80 }]);
});

test('a reload mid-compaction keeps its start time; a failed one leaves its error line', () => {
  const replayed = reduce(emptyFeed, { kind: 'replay', events: [user(), compacting(20)] });
  expect(replayed.compacting).toBe(20);
  const failed = reduce(replayed, agent({ t: 'compact-failed', error: 'prompt too long' }, 30));
  expect(failed.compacting).toBeNull();
  expect(failed.items.at(-1)).toEqual({ key: expect.any(String), kind: 'marker', what: 'compactFailed', error: 'prompt too long', ts: 30 });
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
  expect(cleared.items).toEqual([{ key: expect.any(String), kind: 'marker', what: 'cleared', ts: 7 }]);
  expect(cleared.busy).toBe(false);
  const next = fold([user({ id: 'u2' }), result()], cleared);
  expect(next.items.map((i) => i.kind)).toEqual(['marker', 'user', 'done']);
});

describe('history before a compaction (R-M7-4)', () => {
  const session = (id = 's1'): ServerEvent => ({ kind: 'session', id, root: '/p', title: null, model: null });
  const marker = agent({ t: 'compacted', preTokens: 1000 }, 50);
  /** a reloaded page after one compaction: the kept session event, the boundary, a turn after it */
  const replayed = (earlier = 2, extra: ServerEvent[] = []) =>
    reduce(emptyFeed, { kind: 'replay', events: [session(), marker, user({ id: 'u9', text: 'after' }), ...extra], earlier });
  const page = (s: FeedState, events: ServerEvent[], segment: number, more: boolean) =>
    ({ events, segment, more, session: s.session!.id!, epoch: s.epoch });

  test('the replay sets earlier; a reset and a replay without it clear it', () => {
    expect(replayed(3).earlier).toBe(3);
    expect(reduce(replayed(3), { kind: 'replay', events: [] }).earlier).toBe(0);
    expect(reduce(replayed(3), agent({ t: 'reset', newId: 'n' })).earlier).toBe(0);
    expect(emptyFeed.earlier).toBe(0);
  });

  test('historyPrepended puts the segment\'s feed items first', () => {
    const s = replayed(1);
    const next = prependHistory(s, page(s, [user({ id: 'u1', text: 'before', historic: true }), message('a1:0', 'old reply'), result()], 1, false));
    expect(next.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'done', 'marker', 'user']);
    expect(next.items[0]).toMatchObject({ id: 'u1', text: 'before' });
    expect(next.earlier).toBe(0); // fully loaded
  });

  test('historyPrepended keeps live state', () => {
    // live: a turn is running, one send waits, a compaction runs
    const s = fold([user({ id: 'u10', text: 'running' }), compacting(70)], replayed(2));
    expect(s.busy).toBe(true);
    const seg: ServerEvent[] = [
      session('other'),
      { kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'rm' }, ts: 3 },
      agent({ t: 'task', id: 'k1', phase: 'started', desc: 'explore' }),
      user({ id: 'u1', text: 'old send' }), // not historic: in the segment it ran live
      result({ answers: 'all', queued: 3 }),
      { kind: 'resumed', id: 'abcdef1234' },
    ];
    const next = prependHistory(s, page(s, seg, 2, true));
    expect(next.items.map((i) => i.kind)).toEqual(['permission', 'user', 'done', 'notice', ...s.items.map((i) => i.kind)]);
    expect(next.items[1]).not.toHaveProperty('duringWork'); // reduced on its own: nothing was running before it in the segment
    expect(next.items.slice(4)).toEqual(s.items);
    const { items: _a, earlier: _b, ...live } = next;
    const { items: _c, earlier: _d, ...before } = s;
    expect(live).toEqual(before); // busy, waiting, session, compacting, forcePending, streamN, turnSeq, epoch
    expect(next.earlier).toBe(1);
  });

  test('an item already in the feed moves to its segment position (the live object), its later slot goes: a running send kept across the cut, a queued one replayed from the transcript', () => {
    // the running send u5 stays before the boundary; the queued u6 came back as a historic event of the transcript
    const s = reduce(emptyFeed, {
      kind: 'replay', earlier: 1,
      events: [session(), user({ id: 'u5', text: 'running' }), marker, user({ id: 'u6', text: 'queued', historic: true })],
    });
    const seg = [user({ id: 'u4', text: 'older' }), result(), user({ id: 'u5', text: 'running' }), message('a5:0', 'half'), user({ id: 'u6', text: 'queued' })];
    const next = prependHistory(s, page(s, seg, 1, false));
    expect(next.items.filter((i) => i.kind === 'user').map((i) => (i as { id: string }).id)).toEqual(['u4', 'u5', 'u6']);
    // the prompt, the first half of its replies, then the marker; the queued send sits where the segment had it
    expect(next.items.map((i) => i.kind)).toEqual(['user', 'done', 'user', 'assistant', 'user', 'marker']);
    expect(next.items.map((i) => ('id' in i ? i.id : i.kind))).toEqual(['u4', 'done', 'u5', 'a5:0', 'u6', 'marker']);
    const live = s.items.filter((i) => i.kind === 'user');
    expect(next.items[2]).toBe(live[0]); // the live object, not the segment's copy
    expect(next.items[4]).toBe(live[1]);
  });

  test('a permission item from a segment is archived (read-only); one kept across the cut stays live', () => {
    const s = reduce(emptyFeed, {
      kind: 'replay', earlier: 1,
      events: [session(), { kind: 'permission', id: 'p2', toolName: 'Bash', input: { command: 'ls' }, ts: 3 }, marker],
    });
    const seg: ServerEvent[] = [
      { kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'rm' }, ts: 2 },
      { kind: 'permission', id: 'p2', toolName: 'Bash', input: { command: 'ls' }, ts: 3 },
    ];
    const next = prependHistory(s, page(s, seg, 1, false));
    const [p1, p2] = next.items as Extract<(typeof next.items)[number], { kind: 'permission' }>[];
    expect(p1).toMatchObject({ id: 'p1', archived: true });
    expect(p2!.archived).toBeUndefined();
  });

  test('a page for another session, an older epoch or a segment already loaded is dropped', () => {
    const s = replayed(2);
    const seg = [user({ id: 'u1', historic: true })];
    expect(prependHistory(s, { ...page(s, seg, 2, true), session: 'other' })).toBe(s);
    expect(prependHistory(s, { ...page(s, seg, 2, true), epoch: s.epoch - 1 })).toBe(s);
    const once = prependHistory(s, page(s, seg, 2, true));
    expect(prependHistory(once, page(s, seg, 2, true))).toBe(once); // a second answer for segment 2
    // a replay after the request bumps the epoch
    const again = reduce(s, { kind: 'replay', events: [session(), marker], earlier: 2 });
    expect(again.epoch).toBe(s.epoch + 1);
    expect(prependHistory(again, page(s, seg, 2, true))).toBe(again);
  });
});

describe('a page newer than its server (I3)', () => {
  test('a frame this page has no kind for leaves the state as it was and does not throw', () => {
    const s = fold([user(), start(), delta('x')]);
    const old = { kind: 'sdk', message: { type: 'assistant' } } as unknown as ServerEvent; // protocol 4's raw SDK frame
    expect(() => reduce(s, old)).not.toThrow();
    expect(reduce(s, old)).toBe(s);
    // inside a replay too: the events around it still apply
    const r = reduce(emptyFeed, { kind: 'replay', events: [user(), old, user({ id: 'u2' })] });
    expect(r.items.filter((i) => i.kind === 'user')).toHaveLength(2);
  });

  test('an agent event of an unknown type leaves the state as it was', () => {
    const s = fold([user()]);
    const future = agent({ t: 'from-the-future' } as unknown as WireAgentEvent);
    expect(reduce(s, future)).toBe(s);
  });
});

describe('a ! command block (protocol 11)', () => {
  const shellStart = (id = 'r1', cmd = 'ls'): ServerEvent => ({ kind: 'shell-start', id, cmd, ts: 7 });
  const out = (text: string, id = 'r1', truncated = false): ServerEvent => ({ kind: 'shell-out', id, text, truncated });
  const end = (extra: Partial<Extract<ServerEvent, { kind: 'shell-end' }>> = {}): ServerEvent => ({ kind: 'shell-end', id: 'r1', cmd: 'ls', output: 'a\nb\n', truncated: false, code: 0, ts: 9, ...extra });

  test('a run streams into one block and its end replaces the output; the turn state is untouched', () => {
    const mid = fold([shellStart(), out('a\n'), out('a\nb\n')]); // each frame is the whole tail so far
    expect(mid.items).toEqual([{ kind: 'shell', id: 'r1', cmd: 'ls', output: 'a\nb\n', truncated: false, running: true, code: null, ts: 7 }]);
    expect(mid.busy).toBe(false);
    const done = reduce(mid, end());
    expect(done.items).toEqual([{ kind: 'shell', id: 'r1', cmd: 'ls', output: 'a\nb\n', truncated: false, running: false, code: 0, ts: 7 }]);
    expect(done.busy).toBe(false);
    expect(done.waiting).toEqual([]);
  });

  test('a frame replaces the output, and carries the cut mark', () => {
    const s = fold([shellStart(), out('x'.repeat(SHELL_OUTPUT_CAP) + 'tail', 'r1', true)]);
    const it = s.items[0]!;
    expect(it.kind === 'shell' && it.output.length).toBe(SHELL_OUTPUT_CAP);
    expect(it.kind === 'shell' && it.output.endsWith('xtail')).toBe(true);
    expect(it.kind === 'shell' && it.truncated).toBe(true);
    const later = reduce(s, out('short'));
    expect(later.items[0]).toMatchObject({ output: 'short', truncated: false });
  });

  test('output of a run that is not on screen, or already ended, changes nothing', () => {
    const s = fold([user()]);
    expect(reduce(s, out('x'))).toBe(s);
    const ended = fold([shellStart(), end()]);
    expect(reduce(ended, out('late'))).toBe(ended);
  });

  test('an end with no start (archived by a compaction) makes the block itself; stop and error are kept', () => {
    const s = fold([end({ code: null, stop: 'timeout' }), end({ id: 'r2', code: null, error: 'spawn failed' })]);
    expect(s.items).toMatchObject([{ id: 'r1', running: false, code: null, stop: 'timeout' }, { id: 'r2', error: 'spawn failed' }]);
  });

  test('a replay rebuilds the block; the catch-up output that follows continues it', () => {
    const r = reduce(emptyFeed, { kind: 'replay', events: [shellStart()] });
    const s = fold([out('so far\n')], r);
    expect(s.items).toMatchObject([{ kind: 'shell', running: true, output: 'so far\n' }]);
  });

  test('a start of the same id replaces the old block instead of doubling it', () => {
    const s = fold([shellStart(), out('x'), shellStart()]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ output: '' });
  });
});
