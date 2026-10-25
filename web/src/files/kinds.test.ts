import { expect, it } from 'vitest';
import { fileUrl, isPath, kindOf } from './kinds.ts';

it('kindOf covers each regex', () => {
  expect(kindOf('a/README.md')).toBe('md');
  expect(kindOf('x.MARKDOWN')).toBe('md');
  expect(kindOf('p.PNG')).toBe('image');
  expect(kindOf('p.jpeg')).toBe('image');
  expect(kindOf('p.svg')).toBe('image');
  expect(kindOf('v.mov')).toBe('video');
  expect(kindOf('v.m4v')).toBe('video');
  expect(kindOf('s.m4a')).toBe('audio');
  expect(kindOf('s.ogg')).toBe('audio');
  expect(kindOf('main.ts')).toBe('text');
  expect(kindOf('Makefile')).toBe('text');
});

it('fileUrl resolves relative paths against baseDir and encodes', () => {
  expect(fileUrl('img/a b.png', 'docs')).toBe('/file?path=docs%2Fimg%2Fa%20b.png');
  expect(fileUrl('img/a b.png')).toBe('/file?path=img%2Fa%20b.png');
  expect(fileUrl('a+b.png', 'd')).toBe('/file?path=d%2Fa%2Bb.png');
  expect(fileUrl('../x.png', 'docs/sub')).toBe('/file?path=docs%2Fx.png');
  expect(fileUrl('./x.png', 'docs')).toBe('/file?path=docs%2Fx.png');
  expect(fileUrl('../../x.png', 'docs')).toBe('/file?path=docs%2F..%2F..%2Fx.png'); // above root: left for the server's 403
  expect(fileUrl('https://h/x.png', 'docs')).toBe('https://h/x.png');
  expect(fileUrl('/abs/x.png', 'docs')).toBe('/file?path=%2Fabs%2Fx.png');
});

it('isPath is the prototype predicate', () => {
  expect(isPath('src/a')).toBe(true);
  expect(isPath('a.md')).toBe(true);
  expect(isPath('https://x.y/a.md')).toBe(false);
  expect(isPath('~/a.md')).toBe(false);
  expect(isPath('a b')).toBe(false);
  expect(isPath('a|b/c')).toBe(false);
});
