import { expect, it } from 'vitest';
import type { Comment, MediaAnchor } from '@nota-bene/shared';
import { composeBatch } from './compose.ts';

const c = (id: string, quote: string, text: string, label?: Comment['label']): Comment => ({
  id, text, label, status: 'pending', createdAt: 1,
  anchor: { source: { kind: 'message', id }, start: 0, end: quote.length, quote, prefix: '', suffix: '' },
});
const where = (x: Comment) => (x.id === 'u' ? 'my message' : 'reply');
const none = () => '';

it('general text first, then the header and numbered items', () => {
  const out = composeBatch('Please fix', [c('a', 'foo', ' bar '), c('u', 'baz', 'qux')], 'en', none, where, () => undefined);
  expect(out).toBe('Please fix\n\nComments on fragments:\n\n1. [reply]\n> foo\n→ bar\n\n2. [my message]\n> baz\n→ qux');
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

const media = (id: string, text: string, o: Partial<MediaAnchor> = {}): Comment => ({
  id, text, status: 'pending', createdAt: 1,
  anchor: {
    kind: 'media', source: { kind: 'file', path: 'media/scene_v6.png' }, width: 1920, height: 1080,
    shapes: [
      { kind: 'rect', color: '#ff3b30', x: 0.42, y: 0.4, w: 0.16, h: 0.24 },
      { kind: 'pen', color: '#ff3b30', points: [0.3, 0.5, 0.4, 0.58] },
    ], ...o,
  },
});
const mwhere = () => 'media/scene_v6.png · 1920×1080';

it('a media comment: shape lines, image labels, files', () => {
  const out = composeBatch('', [media('m1', 'The character sits here')], 'en', none, mwhere, () => undefined, [[4]]);
  expect(out).toBe(
    'Comments on fragments:\n\n1. [media/scene_v6.png · 1920×1080]\n' +
    '> rect x=0.42 y=0.4 w=0.16 h=0.24 (px 806,432 307×259)\n' +
    '> pen 2 pts, bbox x=0.3 y=0.5 w=0.1 h=0.08 (px 576,540 192×86)\n' +
    '→ The character sits here\n' +
    '📎 images: 4 (frame with marks)\n' +
    '   files: .nota-bene/marks/m1/frame.jpg, .nota-bene/marks/m1/layer.png',
  );
});

it('media: scaled files, changed file line, pasted images after the labelled ones; ru keeps the format', () => {
  const out = composeBatch('', [media('m1', 'x', { scale: 0.75 })], 'en', none, mwhere, () => undefined, [[1, 2, 3]], () => true);
  expect(out).toContain('📎 images: 1 (frame with marks), 2, 3\n');
  expect(out).toContain('   files: .nota-bene/marks/m1/frame.jpg (scaled ×0.75), .nota-bene/marks/m1/layer.png (scaled ×0.75)\n   (marked on an earlier version of the file; the frame shows it)');
  const ru = composeBatch('', [media('m1', 'x', { scale: 0.75 })], 'ru', none, mwhere, () => undefined, [[4]], () => true);
  expect(ru).toContain('📎 картинки: 4 (кадр с разметкой)\n   файлы: .nota-bene/marks/m1/frame.jpg (уменьшен ×0.75), .nota-bene/marks/m1/layer.png (уменьшен ×0.75)\n   (отмечено на более ранней версии файла; кадр это показывает)');
});
