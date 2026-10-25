import { expect, it } from 'vitest';
import type { Comment } from '@nota-bene/shared';
import { composeBatch } from './compose.ts';

const c = (id: string, quote: string, text: string, label?: Comment['label']): Comment => ({
  id, text, label, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id }, start: 0, end: quote.length, quote, prefix: '', suffix: '' },
});
const where = (x: Comment) => (x.id === 'u' ? 'my message' : 'reply #1');
const none = () => '';

it('general text first, then the header and numbered items', () => {
  const out = composeBatch('Please fix', [c('a', 'foo', ' bar '), c('u', 'baz', 'qux')], 'en', none, where, () => undefined);
  expect(out).toBe('Please fix\n\nComments on fragments:\n\n1. [reply #1]\n> foo\n→ bar\n\n2. [my message]\n> baz\n→ qux');
});

it('omits the leading blank when general is empty; header follows the lang', () => {
  expect(composeBatch('', [c('a', 'x', 'y')], 'ru', none, where, () => undefined)).toMatch(/^Комментарии к фрагментам:\n\n1\./);
});

it('multi-line quotes are each prefixed with "> "', () => {
  const out = composeBatch('', [c('a', 'l1\nl2', 'y')], 'en', none, where, () => undefined);
  expect(out).toContain('> l1\n> l2\n→ y');
});

it('a quick label adds its emoji, text and instruction', () => {
  const out = composeBatch('', [c('a', 'q', '', 'verify')], 'en', () => '🔍 verify', where, () => 'Check this against the code.');
  expect(out).toContain('→ 🔍 verify\n   Check this against the code.');
  const out2 = composeBatch('', [c('a', 'q', 'why?', 'verify')], 'en', () => '🔍 verify', where, () => undefined);
  expect(out2).toContain('→ 🔍 verify why?');
});

it('no comments → general text unchanged', () => {
  expect(composeBatch('just text', [], 'en', none, where, () => undefined)).toBe('just text');
});

it('refs append the imgRef line under the comment, in the batch language', () => {
  const out = composeBatch('', [c('a', 'q', 'y'), c('b', 'q2', 'z')], 'en', none, where, () => undefined, [[2, 3], []]);
  expect(out).toContain('→ y\n📎 images: 2, 3\n\n2. ');
  expect(out).not.toContain('z\n📎');
  expect(composeBatch('', [c('a', 'q', 'y')], 'ru', none, where, () => undefined, [[1]])).toContain('→ y\n📎 изображения: 1');
});
