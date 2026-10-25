import { expect, test } from 'vitest';
import { parseClientMessage } from './protocol.ts';

test('accepts a send', () => expect(parseClientMessage('{"type":"send","id":"u1","text":"hi"}')).toEqual({ type: 'send', id: 'u1', text: 'hi' }));
test('rejects bad json', () => expect(parseClientMessage('{nope')).toHaveProperty('error'));
test('rejects unknown type', () => expect(parseClientMessage('{"type":"rm -rf"}')).toEqual({ error: 'unknown message type: rm -rf' }));
test('rejects send without text', () => expect(parseClientMessage('{"type":"send","id":"u1"}')).toHaveProperty('error'));
test('permission needs boolean allow', () => expect(parseClientMessage('{"type":"permission","id":"p","allow":"yes"}')).toHaveProperty('error'));

const anchor = { source: { kind: 'message', id: 'm1' }, start: 2, end: 5, quote: 'abc', prefix: 'x', suffix: 'y' };
const comment = (over: Record<string, unknown> = {}) => ({ id: 'c1', anchor, text: 'note', status: 'pending', createdAt: 1, ...over });
const comments = (c: unknown) => JSON.stringify({ type: 'comments', items: [c] });

test('accepts a comments message with a valid comment', () => {
  const c = comment({ label: 'clarify', text: '' });
  expect(parseClientMessage(comments(c))).toEqual({ type: 'comments', items: [c] });
  const f = comment({ anchor: { ...anchor, source: { kind: 'file', path: 'a/b.ts' } }, status: 'sent', sentIn: 'u1' });
  expect(parseClientMessage(comments(f))).toEqual({ type: 'comments', items: [f] });
  expect(parseClientMessage('{"type":"comments","items":[]}')).toEqual({ type: 'comments', items: [] });
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
  expect(parseClientMessage('{"type":"comments","items":"no"}')).toHaveProperty('error');
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
  expect(parseClientMessage(comments(dirty))).toStrictEqual({ type: 'comments', items: [clean] });
});
