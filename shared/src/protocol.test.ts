import { expect, test } from 'vitest';
import { parseClientMessage } from './protocol.ts';

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
