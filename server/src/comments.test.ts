import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { CommentStore } from './comments.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-comments-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const c = (id: string): Comment => ({
  id, text: `t-${id}`, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id: 'm1' }, quote: 'q', start: 0, end: 1 },
} as unknown as Comment);

describe('CommentStore', () => {
  it('set then get round-trips and persists to <dir>/<id>.json', () => {
    const s = new CommentStore({ dir });
    s.set('abc-1', [c('a')]);
    expect(s.get('abc-1')).toEqual([c('a')]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'abc-1.json'), 'utf8'))).toEqual([c('a')]);
    expect(new CommentStore({ dir }).get('abc-1')).toEqual([c('a')]);
    expect(fs.readdirSync(dir)).toEqual(['abc-1.json']);
  });
  it('get returns a copy', () => {
    const s = new CommentStore({ dir });
    s.set('abc', [c('a')]);
    s.get('abc').push(c('b'));
    expect(s.get('abc')).toHaveLength(1);
    s.get(null).push(c('b'));
    expect(s.get(null)).toHaveLength(0);
  });
  it('null session stays in memory and writes no file', () => {
    const s = new CommentStore({ dir });
    s.set(null, [c('a')]);
    expect(s.get(null)).toEqual([c('a')]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('adopt moves the in-memory set under the id', () => {
    const s = new CommentStore({ dir });
    s.set(null, [c('a')]);
    s.adopt('sess-2');
    expect(s.get(null)).toEqual([]);
    expect(s.get('sess-2')).toEqual([c('a')]);
    expect(fs.existsSync(path.join(dir, 'sess-2.json'))).toBe(true);
  });
  it('adopt merges by id, stored entries first, no duplicates', () => {
    const s = new CommentStore({ dir });
    s.set('sess', [{ ...c('a'), text: 'stored' }]);
    s.set(null, [{ ...c('a'), text: 'mem' }, c('b')]);
    s.adopt('sess');
    expect(s.get('sess').map((x) => [x.id, x.text])).toEqual([['a', 'stored'], ['b', 't-b']]);
  });
  it('adopt prefers the sent copy over a stored pending one', () => {
    const s = new CommentStore({ dir });
    s.set('sess', [c('a'), { ...c('b'), status: 'sent', sentIn: 'u0' }]);
    s.set(null, [{ ...c('a'), status: 'sent', sentIn: 'u1' }, c('b')]);
    s.adopt('sess');
    expect(s.get('sess').map((x) => [x.id, x.status, x.sentIn])).toEqual([['a', 'sent', 'u1'], ['b', 'sent', 'u0']]);
  });
  it('merge keeps stored sent comments: a pending copy stays sent, a missing one is re-appended', () => {
    const s = new CommentStore({ dir });
    const sent = (id: string): Comment => ({ ...c(id), status: 'sent', sentIn: 'u1' });
    s.set('m', [sent('a'), sent('b'), c('p')]);
    const out = s.merge('m', [{ ...c('a'), text: 'stale' }, c('p'), c('n')]);
    expect(out.map((x) => [x.id, x.status])).toEqual([['a', 'sent'], ['p', 'pending'], ['n', 'pending'], ['b', 'sent']]);
    expect(out[0]).toEqual(sent('a'));
    expect(s.get('m')).toEqual(out);
    // the in-memory (pre-init) set follows the same rule
    s.set(null, [sent('x')]);
    expect(s.merge(null, [c('x')])).toEqual([sent('x')]);
  });
  it('a non-ENOENT read error is rethrown, not read as []', () => {
    fs.mkdirSync(path.join(dir, 'dirasfile.json'));
    expect(() => new CommentStore({ dir }).get('dirasfile')).toThrow();
  });
  it('drops stored elements without a string id', () => {
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify([1, null, { id: 5 }, c('a')]));
    expect(new CommentStore({ dir }).get('x')).toEqual([c('a')]);
  });
  it('markSent sets status and sentIn only for the given ids', () => {
    const s = new CommentStore({ dir });
    s.set('s', [c('a'), c('b')]);
    const out = s.markSent('s', ['a'], 'msg-1');
    expect(out.find((x) => x.id === 'a')).toMatchObject({ status: 'sent', sentIn: 'msg-1' });
    expect(out.find((x) => x.id === 'b')).toMatchObject({ status: 'pending' });
    expect(out.find((x) => x.id === 'b')?.sentIn).toBeUndefined();
    expect(new CommentStore({ dir }).get('s')).toEqual(out);
  });
  it('a corrupt or non-array file reads as []', () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    fs.writeFileSync(path.join(dir, 'obj.json'), '{"a":1}');
    const s = new CommentStore({ dir });
    expect(s.get('bad')).toEqual([]);
    expect(s.get('obj')).toEqual([]);
  });
  it('rejects session ids that are not safe file names', () => {
    const s = new CommentStore({ dir });
    for (const id of ['../x', 'a/b', '', 'a.b', 'x'.repeat(101)]) {
      expect(() => s.get(id)).toThrow();
      expect(() => s.set(id, [])).toThrow();
    }
    expect(() => s.set('fake-session', [])).not.toThrow();
  });
});
