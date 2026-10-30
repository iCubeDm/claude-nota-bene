import { expect, test } from 'vitest';
import { generatedImages, parseClientMessage, toAnchor, type MediaAnchor } from './protocol.ts';

test('accepts a send', () => expect(parseClientMessage('{"type":"send","id":"u1","text":"hi"}')).toEqual({ type: 'send', id: 'u1', text: 'hi' }));
test('rejects bad json', () => expect(parseClientMessage('{nope')).toHaveProperty('error'));
test('rejects unknown type', () => expect(parseClientMessage('{"type":"rm -rf"}')).toEqual({ error: 'unknown message type: rm -rf' }));
test('rejects send without text', () => expect(parseClientMessage('{"type":"send","id":"u1"}')).toHaveProperty('error'));
test('permission needs boolean allow', () => expect(parseClientMessage('{"type":"permission","id":"p","allow":"yes"}')).toHaveProperty('error'));

const anchor = { source: { kind: 'message', id: 'm1' }, start: 2, end: 5, quote: 'abc', prefix: 'x', suffix: 'y' };
const comment = (over: Record<string, unknown> = {}) => ({ id: 'c1', anchor, text: 'note', status: 'pending', createdAt: 1, ...over });
const comments = (c: unknown, sessionId: unknown = null) => JSON.stringify({ type: 'comments', sessionId, items: [c] });

test('accepts a comments message with a valid comment', () => {
  const c = comment({ label: 'clarify', text: '' });
  expect(parseClientMessage(comments(c))).toEqual({ type: 'comments', sessionId: null, items: [c] });
  const f = comment({ anchor: { ...anchor, source: { kind: 'file', path: 'a/b.ts' } }, status: 'sent', sentIn: 'u1' });
  expect(parseClientMessage(comments(f))).toEqual({ type: 'comments', sessionId: null, items: [f] });
  expect(parseClientMessage('{"type":"comments","sessionId":null,"items":[]}')).toEqual({ type: 'comments', sessionId: null, items: [] });
});
test('rejects a comment with end < start', () => {
  expect(parseClientMessage(comments(comment({ anchor: { ...anchor, start: 5, end: 2 } })))).toHaveProperty('error');
  expect(parseClientMessage(comments(comment({ anchor: { ...anchor, start: -1 } })))).toHaveProperty('error');
  expect(parseClientMessage(comments(comment({ anchor: { ...anchor, end: 2.5 } })))).toHaveProperty('error');
});
test('rejects an unknown label', () => {
  expect(parseClientMessage(comments(comment({ label: 'nope' })))).toHaveProperty('error');
});
test('rejects a comment with empty text and no label, or other bad shapes', () => {
  expect(parseClientMessage(comments(comment({ text: '' })))).toHaveProperty('error');
  expect(parseClientMessage(comments(comment({ status: 'done' })))).toHaveProperty('error');
  expect(parseClientMessage(comments(comment({ anchor: { ...anchor, source: { kind: 'x' } } })))).toHaveProperty('error');
  expect(parseClientMessage('{"type":"comments","sessionId":null,"items":"no"}')).toHaveProperty('error');
});
test('send accepts commentIds as string[] and rejects other shapes', () => {
  expect(parseClientMessage('{"type":"send","id":"u1","text":"hi","commentIds":["c1"]}'))
    .toEqual({ type: 'send', id: 'u1', text: 'hi', commentIds: ['c1'] });
  expect(parseClientMessage('{"type":"send","id":"u1","text":"hi","commentIds":[]}'))
    .toEqual({ type: 'send', id: 'u1', text: 'hi', commentIds: [] });
  expect(parseClientMessage('{"type":"send","id":"u1","text":"hi","commentIds":"c1"}')).toHaveProperty('error');
  expect(parseClientMessage('{"type":"send","id":"u1","text":"hi","commentIds":[1]}')).toHaveProperty('error');
});
test('comments drop unknown keys on comment, anchor and source', () => {
  const dirty = comment({
    evil: 1, label: 'verify',
    anchor: { ...anchor, extra: 2, source: { kind: 'message', id: 'm1', x: 3 } },
  });
  const clean = { id: 'c1', anchor, text: 'note', label: 'verify', status: 'pending', createdAt: 1 };
  expect(parseClientMessage(comments(dirty))).toStrictEqual({ type: 'comments', sessionId: null, items: [clean] });
});
const H = 'a'.repeat(64);
test('send with images keeps only valid refs', () => {
  const send = (images: unknown) => JSON.stringify({ type: 'send', id: 'u1', text: 'hi', images });
  const ok = { id: H, mediaType: 'image/png', label: '[image 1]' };
  expect(parseClientMessage(send([{ ...ok, extra: 1 }])))
    .toStrictEqual({ type: 'send', id: 'u1', text: 'hi', images: [ok] });
  expect(parseClientMessage(send([{ ...ok, id: '../x' }]))).toHaveProperty('error');
  expect(parseClientMessage(send([{ ...ok, mediaType: 'image/heic' }]))).toHaveProperty('error');
  expect(parseClientMessage(send([{ ...ok, label: 1 }]))).toHaveProperty('error');
  expect(parseClientMessage(send('x'))).toHaveProperty('error');
});
test('genImages is a count; generatedImages: 2 for an old media comment, genImages for a new one, 0 for text', () => {
  expect(parseClientMessage(comments(comment({ genImages: 1 })))).toMatchObject({ items: [{ genImages: 1 }] });
  expect(parseClientMessage(comments(comment({ genImages: -1 })))).toHaveProperty('error');
  const media = { kind: 'media', source: { kind: 'file', path: 'a.png' }, width: 1, height: 1, shapes: [] } as never;
  expect(generatedImages({ ...(comment() as object), anchor: media } as never)).toBe(2);
  expect(generatedImages({ ...(comment() as object), anchor: media, genImages: 1 } as never)).toBe(1);
  expect(generatedImages(comment() as never)).toBe(0);
});

test('comment images are ids', () => {
  const c = comment({ images: [H] });
  expect(parseClientMessage(comments(c))).toStrictEqual({ type: 'comments', sessionId: null, items: [c] });
  expect(parseClientMessage(comments(comment({ images: ['../x'] })))).toHaveProperty('error');
  expect(parseClientMessage(comments(comment({ images: [H.toUpperCase()] })))).toHaveProperty('error');
});

test('a file anchor keeps its ref (branch), a string of at most 200 chars', () => {
  const src = { kind: 'file', path: 'a.md', ref: 'feature/x' };
  const c = comment({ anchor: { ...anchor, source: { ...src, junk: 1 } } });
  expect(parseClientMessage(comments(c))).toEqual({ type: 'comments', sessionId: null, items: [comment({ anchor: { ...anchor, source: src } })] });
  expect(parseClientMessage(comments(comment({ anchor: { ...anchor, source: { kind: 'file', path: 'a.md', ref: 3 } } })))).toHaveProperty('error');
  expect(parseClientMessage(comments(comment({ anchor: { ...anchor, source: { kind: 'file', path: 'a.md', ref: 'x'.repeat(201) } } })))).toHaveProperty('error');
  const plain = comment({ anchor: { ...anchor, source: { kind: 'file', path: 'a.md' } } });
  expect(parseClientMessage(comments(plain))).toEqual({ type: 'comments', sessionId: null, items: [plain] });
});

const SID = '5f0c2a9e-7d41-4c4b-9e1a-0123456789ab';
const P = (o: unknown) => parseClientMessage(JSON.stringify(o));
test('comments carry a sessionId: string id or null, required', () => {
  expect(P({ type: 'comments', items: [] })).toHaveProperty('error');
  expect(P({ type: 'comments', sessionId: 5, items: [] })).toHaveProperty('error');
  expect(P({ type: 'comments', sessionId: SID, items: [] })).toEqual({ type: 'comments', sessionId: SID, items: [] });
});
test('model needs a model id; effort is one of the five levels; id is a short string', () => {
  expect(P({ type: 'model', model: 'sonnet' })).toEqual({ type: 'model', model: 'sonnet' });
  expect(P({ type: 'model', model: 'opus', effort: 'xhigh', id: 'a1', extra: 1 })).toEqual({ type: 'model', model: 'opus', effort: 'xhigh', id: 'a1' });
  for (const bad of [{}, { model: '' }, { model: 3 }, { model: 'x'.repeat(201) }, { model: 'a', effort: 'ultra' }, { model: 'a', effort: 3 }, { model: 'a', id: 5 }, { model: 'a', id: 'x'.repeat(65) }]) {
    expect(P({ type: 'model', ...bad })).toHaveProperty('error');
  }
});

test('mode accepts the four modes only', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) expect(P({ type: 'mode', mode })).toEqual({ type: 'mode', mode });
  expect(P({ type: 'mode', mode: 'yolo' })).toHaveProperty('error');
  expect(P({ type: 'mode' })).toHaveProperty('error');
});
test('command accepts compact and clear only', () => {
  expect(P({ type: 'command', name: 'compact' })).toEqual({ type: 'command', name: 'compact' });
  expect(P({ type: 'command', name: 'clear' })).toEqual({ type: 'command', name: 'clear' });
  expect(P({ type: 'command', name: 'rm' })).toHaveProperty('error');
  expect(P({ type: 'command' })).toHaveProperty('error');
});
test('switch needs an id (uuid or null) and an absolute dir', () => {
  expect(P({ type: 'switch', id: SID, dir: '/a/b', x: 1 })).toStrictEqual({ type: 'switch', id: SID, dir: '/a/b' });
  expect(P({ type: 'switch', id: null, dir: '/a' })).toEqual({ type: 'switch', id: null, dir: '/a' });
  expect(P({ type: 'switch', id: 'nope', dir: '/a' })).toHaveProperty('error');
  expect(P({ type: 'switch', id: '../../etc/passwd-xxxxxxxxxxxxxxxxxxxxxxx', dir: '/a' })).toHaveProperty('error');
  expect(P({ type: 'switch', id: SID, dir: 'rel/dir' })).toHaveProperty('error');
  expect(P({ type: 'switch', id: SID })).toHaveProperty('error');
  expect(P({ type: 'switch', dir: '/a' })).toHaveProperty('error');
});
test('restart parses', () => expect(P({ type: 'restart' })).toEqual({ type: 'restart' }));
test('permission keeps an optional input object', () => {
  expect(P({ type: 'permission', id: 'p', allow: true, input: { plan: 'x' } })).toEqual({ type: 'permission', id: 'p', allow: true, input: { plan: 'x' } });
  expect(P({ type: 'permission', id: 'p', allow: true })).toStrictEqual({ type: 'permission', id: 'p', allow: true });
  expect(P({ type: 'permission', id: 'p', allow: true, input: 'x' })).toHaveProperty('error');
  expect(P({ type: 'permission', id: 'p', allow: true, input: [1] })).toHaveProperty('error');
});

test('activity and idle-compact (only a boolean on; extra keys dropped)', () => {
  expect(parseClientMessage('{"type":"activity","x":1}')).toEqual({ type: 'activity' });
  expect(parseClientMessage('{"type":"idle-compact","on":false,"x":1}')).toEqual({ type: 'idle-compact', on: false });
  expect(parseClientMessage('{"type":"idle-compact","on":"no"}')).toHaveProperty('error');
});

const mediaAnchor = (over: Record<string, unknown> = {}) => ({
  kind: 'media', source: { kind: 'file', path: 'img/a.png' }, width: 640, height: 480,
  shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 }], ...over,
});
const parseMedia = (a: unknown) => parseClientMessage(comments(comment({ anchor: a })));

test('parses a comment with a media anchor (rect, ellipse, arrow, pen; time; version)', () => {
  const a = mediaAnchor({
    time: 12.345, version: '"abc"',
    source: { kind: 'file', path: 'v/a.mp4', ref: 'main' },
    shapes: [
      { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      { kind: 'ellipse', color: '#ffcc00', x: 0, y: 0, w: 1, h: 1 },
      { kind: 'arrow', color: '#0a84ff', x1: 0, y1: 0.5, x2: 1, y2: 0.5 },
      { kind: 'pen', color: '#ffffff', points: [0, 0, 0.5, 0.5, 1, 1] },
    ],
  });
  expect(parseMedia(a)).toEqual({ type: 'comments', sessionId: null, items: [comment({ anchor: a })] });
});

const rect = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
const rejectCases: [string, unknown][] = [
  ['x > 1', mediaAnchor({ shapes: [{ ...rect, x: 1.5 }] })],
  ['rect w = 0', mediaAnchor({ shapes: [{ ...rect, w: 0 }] })],
  ['rect h = 0', mediaAnchor({ shapes: [{ ...rect, h: 0 }] })],
  ['rect x + w > 1', mediaAnchor({ shapes: [{ ...rect, x: 0.8, w: 0.3 }] })],
  ['rect y + h > 1', mediaAnchor({ shapes: [{ ...rect, y: 0.9, h: 0.2 }] })],
  ['ellipse x + w > 1', mediaAnchor({ shapes: [{ ...rect, kind: 'ellipse', x: 0.5, w: 0.6 }] })],
  ['ellipse y + h > 1', mediaAnchor({ shapes: [{ ...rect, kind: 'ellipse', y: 1, h: 0.01 }] })],
  ['arrow x2 > 1', mediaAnchor({ shapes: [{ kind: 'arrow', color: '#ff3b30', x1: 0, y1: 0, x2: 2, y2: 0 }] })],
  ['arrow y1 < 0', mediaAnchor({ shapes: [{ kind: 'arrow', color: '#ff3b30', x1: 0, y1: -0.1, x2: 1, y2: 0 }] })],
  ['pen odd count', mediaAnchor({ shapes: [{ kind: 'pen', color: '#ff3b30', points: [0, 0, 0.5] }] })],
  ['pen over 20000', mediaAnchor({ shapes: [{ kind: 'pen', color: '#ff3b30', points: new Array(20002).fill(0.5) }] })],
  ['pen value < 0', mediaAnchor({ shapes: [{ kind: 'pen', color: '#ff3b30', points: [0, 0, -0.5, 0.2] }] })],
  ['unknown colour', mediaAnchor({ shapes: [{ ...rect, color: '#123456' }] })],
  ['unknown shape kind', mediaAnchor({ shapes: [{ ...rect, kind: 'star' }] })],
  ['shapes empty', mediaAnchor({ shapes: [] })],
  ['width <= 0', mediaAnchor({ width: 0 })],
  ['height <= 0', mediaAnchor({ height: 0 })],
  ['source is a message', mediaAnchor({ source: { kind: 'message', id: 'm1' } })],
  ['empty ref on a file source', mediaAnchor({ source: { kind: 'file', path: 'a.png', ref: '' } })],
  ['negative time', mediaAnchor({ time: -1 })],
  ['non-finite time (NaN serialises to null)', mediaAnchor({ time: null })],
  ['version over 200 chars', mediaAnchor({ version: 'x'.repeat(201) })],
  ['scale 1 (an unscaled render has no field)', mediaAnchor({ scale: 1 })],
  ['scale 0', mediaAnchor({ scale: 0 })],
  ['scale > 1', mediaAnchor({ scale: 1.5 })],
  ['scale not a number', mediaAnchor({ scale: '0.5' })],
];
test.each(rejectCases)('rejects a media anchor: %s', (_name, a) => {
  expect(parseMedia(a)).toHaveProperty('error');
});

test('a rect/ellipse may touch the far edge, with 4-decimal rounding slack (1e-4)', () => {
  for (const kind of ['rect', 'ellipse']) {
    for (const box of [{ x: 0.7, y: 0.6, w: 0.3, h: 0.4 }, { x: 0.3334, y: 0.5, w: 0.6667, h: 0.5 }, { x: 0, y: 0.00005, w: 1, h: 1 }]) {
      expect(parseMedia(mediaAnchor({ shapes: [{ kind, color: '#ff3b30', ...box }] }))).not.toHaveProperty('error');
    }
  }
});

test('toAnchor copies a media anchor deeply and drops unknown keys', () => {
  const input = {
    kind: 'media', junk: 1, source: { kind: 'file', path: 'a.png', junk: 2 }, width: 10, height: 20, time: 1.5, version: 'v',
    shapes: [
      { kind: 'pen', color: '#ff3b30', points: [0, 0, 1, 1], junk: 3 },
      { kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 1, h: 1, junk: 4 },
    ],
  } as unknown as MediaAnchor;
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = toAnchor(input) as MediaAnchor;
  expect(JSON.stringify(out)).not.toMatch(/junk/);
  expect(out.shapes).not.toBe(input.shapes);
  expect(out.shapes[0]).not.toBe(input.shapes[0]);
  expect(out.source).not.toBe(input.source);
  (out.shapes[0] as { points: number[] }).points[0] = 0.9;
  (out.shapes[1] as { x: number }).x = 0.5;
  out.source.path = 'changed';
  expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
});

test('a media anchor with a scale below 1 parses, and toAnchor keeps it', () => {
  const a = mediaAnchor({ scale: 0.75 });
  expect(parseMedia(a)).toEqual({ type: 'comments', sessionId: null, items: [comment({ anchor: a })] });
  expect(toAnchor(a as unknown as MediaAnchor)).toMatchObject({ scale: 0.75 });
  expect(toAnchor(mediaAnchor() as unknown as MediaAnchor)).not.toHaveProperty('scale');
});

test('a message anchor may name a subagent; the field survives, unknown keys do not, a bad id is refused', () => {
  const c = comment({ anchor: { ...anchor, source: { kind: 'message', id: 'm1', agent: 'toolu_01AbC' } } });
  expect(parseClientMessage(comments(c))).toEqual({ type: 'comments', sessionId: null, items: [c] });
  const extra = comment({ anchor: { ...anchor, source: { kind: 'message', id: 'm1', agent: 'toolu_01', x: 1 } } });
  const out = parseClientMessage(comments(extra)) as { items: { anchor: { source: unknown } }[] };
  expect(out.items[0]!.anchor.source).toEqual({ kind: 'message', id: 'm1', agent: 'toolu_01' });
  for (const agent of ['../x', 'a/b', '', 7, 'x'.repeat(200)]) {
    expect(parseClientMessage(comments(comment({ anchor: { ...anchor, source: { kind: 'message', id: 'm1', agent } } })))).toHaveProperty('error');
  }
});
test('an old message anchor without agent is unchanged', () => {
  expect(toAnchor(anchor as never)).toEqual(anchor);
});

import { FINISHED_CAP, orderedTasks, reduceTasks, taskKind } from './tasks.ts';
const T = (ts: number, e: object) => ({ kind: 'agent', ts, e: { t: 'task', ...e } }) as never;
test('a task keeps the call id of its start; its end keeps it as finished', () => {
  const s = reduceTasks({}, T(5, { id: 'k', phase: 'started', desc: 'd', type: 'local_agent', call: 'toolu_A' }));
  expect(s.k).toMatchObject({ call: 'toolu_A', status: 'running', kind: 'agent' });
  expect(s.k).not.toHaveProperty('end');
  expect(reduceTasks(s, T(6, { id: 'k', phase: 'done' })).k).toMatchObject({ call: 'toolu_A', status: 'done', end: 6 });
});
test('status of the end: failed and stopped come from the event; a second end changes nothing; late progress is ignored', () => {
  let s = reduceTasks({}, T(1, { id: 'a', phase: 'started', desc: 'a', type: 'local_bash' }));
  s = reduceTasks(s, T(2, { id: 'a', phase: 'done', status: 'stopped' }));
  s = reduceTasks(s, T(3, { id: 'a', phase: 'done' }));
  s = reduceTasks(s, T(4, { id: 'a', phase: 'progress', tokens: 9, tool: 'x', summary: 'y' }));
  expect(s.a).toMatchObject({ status: 'stopped', end: 2, tokens: 0, kind: 'shell' });
  expect(reduceTasks(reduceTasks({}, T(1, { id: 'b', phase: 'started', desc: 'b' })), T(2, { id: 'b', phase: 'done', status: 'failed' })).b?.status).toBe('failed');
});
test('parent is kept from the start; an unknown task id changes nothing', () => {
  const s = reduceTasks({}, T(1, { id: 'c', phase: 'started', desc: 'c', type: 'local_bash', parent: 'p' }));
  expect(s.c?.parent).toBe('p');
  expect(reduceTasks(s, T(2, { id: 'zz', phase: 'done' }))).toBe(s);
});
test('only the newest FINISHED_CAP finished tasks stay, running ones never go; replay gives the same state', () => {
  const evs = [T(1, { id: 'run', phase: 'started', desc: 'run', type: 'local_agent' })];
  for (let i = 0; i < FINISHED_CAP + 5; i++) evs.push(T(10 + 2 * i, { id: `t${i}`, phase: 'started', desc: `t${i}` }), T(11 + 2 * i, { id: `t${i}`, phase: 'done' }));
  const s = evs.reduce(reduceTasks, {} as ReturnType<typeof reduceTasks>);
  expect(Object.keys(s)).toHaveLength(FINISHED_CAP + 1);
  expect(s.t0).toBeUndefined();
  expect(s.t5).toBeDefined();
  expect(s.run?.status).toBe('running');
  expect(reduceTasks({}, { kind: 'replay', events: evs as never, ts: 0 } as never)).toEqual(s);
  expect(orderedTasks(s).map(([id]) => id).slice(0, 3)).toEqual(['run', `t${FINISHED_CAP + 4}`, `t${FINISHED_CAP + 3}`]);
});
test('a task resumed with SendMessage (another start of the same id) keeps its original call, and runs again from zero', () => {
  let s = reduceTasks({}, T(1, { id: 'k', phase: 'started', desc: 'review', type: 'local_agent', call: 'toolu_A', parent: 'p', bg: true }));
  s = reduceTasks(s, T(2, { id: 'k', phase: 'progress', tokens: 50, tool: 'Read', summary: 's' }));
  s = reduceTasks(s, T(3, { id: 'k', phase: 'done' }));
  expect(s.k).toMatchObject({ status: 'done', end: 3, tokens: 50 });
  s = reduceTasks(s, T(10, { id: 'k', phase: 'started', desc: 'review', type: 'local_agent', call: 'toolu_SendMessage' }));
  expect(s.k).toMatchObject({ call: 'toolu_A', kind: 'agent', parent: 'p', bg: true, status: 'running', start: 10, tokens: 0, tool: '', summary: '' });
  expect(s.k).not.toHaveProperty('end');
  s = reduceTasks(s, T(11, { id: 'k', phase: 'started', desc: 'review', type: 'local_agent', call: 'toolu_SendMessage2' }));
  expect(s.k?.call).toBe('toolu_A'); // a second resume too
  expect(reduceTasks(s, T(12, { id: 'k', phase: 'done' })).k).toMatchObject({ call: 'toolu_A', status: 'done', end: 12 });
});
test('a restart of a known task that had no call takes the new one; an unknown id is a plain start; replay equals the fold', () => {
  const evs = [
    T(1, { id: 'a', phase: 'started', desc: 'a' }),
    T(2, { id: 'a', phase: 'started', desc: 'a', type: 'local_agent', call: 'toolu_X' }),
    T(3, { id: 'b', phase: 'started', desc: 'b', type: 'local_agent', call: 'toolu_Y' }),
    T(4, { id: 'b', phase: 'done' }),
    T(5, { id: 'b', phase: 'started', desc: 'b', type: 'local_agent', call: 'toolu_Z' }),
  ];
  const s = evs.reduce(reduceTasks, {} as ReturnType<typeof reduceTasks>);
  expect(s.a).toMatchObject({ call: 'toolu_X', kind: 'agent' });
  expect(s.b).toMatchObject({ call: 'toolu_Y', status: 'running' });
  expect(reduceTasks({}, { kind: 'replay', events: evs as never, ts: 0 } as never)).toEqual(s);
});
test('taskKind', () => {
  expect([taskKind('local_agent'), taskKind('remote_agent'), taskKind('local_bash'), taskKind('monitor_mcp'), taskKind('local_workflow'), taskKind('', 'toolu_A'), taskKind('')])
    .toEqual(['agent', 'agent', 'shell', 'shell', 'other', 'agent', 'other']);
});

test('task-stop and task-background parse strictly', () => {
  expect(parseClientMessage('{"type":"task-stop","id":"b4k2x9"}')).toEqual({ type: 'task-stop', id: 'b4k2x9' });
  expect(parseClientMessage('{"type":"task-stop","id":"b4k2x9","x":1}')).toEqual({ type: 'task-stop', id: 'b4k2x9' });
  expect(parseClientMessage('{"type":"task-background","toolUseId":"toolu_01AbC"}')).toEqual({ type: 'task-background', toolUseId: 'toolu_01AbC' });
  for (const bad of ['{"type":"task-stop"}', '{"type":"task-stop","id":7}', '{"type":"task-stop","id":"../x"}', '{"type":"task-stop","id":""}',
    '{"type":"task-background"}', '{"type":"task-background","toolUseId":"a/b"}', '{"type":"task-background","id":"x"}']) {
    expect(parseClientMessage(bad)).toHaveProperty('error');
  }
});

test('bg: the CLI\'s is_backgrounded is kept from the start and moved by an update; an update with only bg changes nothing else', () => {
  let s = reduceTasks({}, T(1, { id: 'a', phase: 'started', desc: 'a', type: 'local_bash', bg: false }));
  expect(s.a?.bg).toBe(false);
  s = reduceTasks(s, T(2, { id: 'a', phase: 'updated', bg: true }));
  expect(s.a).toMatchObject({ bg: true, desc: 'a' });
  expect(reduceTasks({}, T(1, { id: 'b', phase: 'started', desc: 'b' })).b).not.toHaveProperty('bg');
  expect(reduceTasks({}, T(1, { id: 'w', phase: 'started', desc: 'w', ambient: true })).w?.ambient).toBe(true);
});

// ---- a model view's camera (protocol 9) ----
const cam = (over: Record<string, unknown> = {}) => ({ position: [1, 2, 3], target: [0, 0.5, 0], fov: 45, ...over });

test('a media anchor may carry a camera; it round-trips and a model anchor has no time', () => {
  const a = mediaAnchor({ source: { kind: 'file', path: 'm/a.glb' }, version: '"v"', camera: cam() });
  expect(parseMedia(a)).toEqual({ type: 'comments', sessionId: null, items: [comment({ anchor: a })] });
  const out = toAnchor(a as unknown as MediaAnchor) as MediaAnchor;
  expect(out.camera).toEqual(cam());
  expect('time' in out).toBe(false);
});

test('an anchor without a camera is unchanged (no camera key appears)', () => {
  const a = mediaAnchor({ time: 2 });
  expect('camera' in (toAnchor(a as unknown as MediaAnchor) as MediaAnchor)).toBe(false);
  expect(parseMedia(a)).not.toHaveProperty('error');
});

test('camera: unknown keys are dropped, in the camera and not copied by reference', () => {
  const input = mediaAnchor({ camera: { ...cam(), junk: 1 } }) as unknown as MediaAnchor;
  const out = toAnchor(input) as MediaAnchor;
  expect(JSON.stringify(out.camera)).not.toMatch(/junk/);
  expect(out.camera!.position).not.toBe(input.camera!.position);
  const parsed = parseMedia(input) as { items: { anchor: MediaAnchor }[] };
  expect(parsed.items[0].anchor.camera).toEqual(cam());
});

const badCameras: [string, unknown][] = [
  ['NaN (serialises to null)', cam({ position: [1, null, 3] })],
  ['position of 2', cam({ position: [1, 2] })],
  ['position of 4', cam({ position: [1, 2, 3, 4] })],
  ['target not an array', cam({ target: 'x' })],
  ['target string numbers', cam({ target: ['0', '0', '0'] })],
  ['fov 0', cam({ fov: 0 })],
  ['fov 180', cam({ fov: 180 })],
  ['fov negative', cam({ fov: -5 })],
  ['fov missing', { position: [1, 2, 3], target: [0, 0, 0] }],
  ['fov a string', cam({ fov: '45' })],
  ['camera null', null],
  ['camera an array', [1, 2, 3]],
];
test.each(badCameras)('rejects a camera: %s', (_n, c) => {
  expect(parseMedia(mediaAnchor({ camera: c }))).toHaveProperty('error');
});

test('camera fov bounds: (0, 180) exclusive', () => {
  for (const fov of [0.01, 45, 179.99]) expect(parseMedia(mediaAnchor({ camera: cam({ fov }) }))).not.toHaveProperty('error');
});

test('a model comment has no time: camera together with time is rejected', () => {
  expect(parseMedia(mediaAnchor({ camera: cam(), time: 2 }))).toHaveProperty('error');
});
