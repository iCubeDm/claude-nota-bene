import { afterEach, expect, it } from 'vitest';
import { fileUrl, isPath, kindOf, modelUrl, setModel3d } from './kinds.ts';

afterEach(() => setModel3d(false));

it('kindOf covers each regex', () => {
  setModel3d(true);
  expect(kindOf('a/README.md')).toBe('md');
  expect(kindOf('x.MARKDOWN')).toBe('md');
  expect(kindOf('p.PNG')).toBe('image');
  expect(kindOf('p.jpeg')).toBe('image');
  expect(kindOf('p.svg')).toBe('image');
  expect(kindOf('v.mov')).toBe('video');
  expect(kindOf('v.m4v')).toBe('video');
  expect(kindOf('s.m4a')).toBe('audio');
  expect(kindOf('s.ogg')).toBe('audio');
  expect(kindOf('m/robot.glb')).toBe('model');
  expect(kindOf('ROBOT.GLB')).toBe('model');
  expect(kindOf('scene.gltf')).toBe('model');
  expect(kindOf('scene.blend')).toBe('model');
  expect(kindOf('SCENE.BLEND')).toBe('model');
  expect(kindOf('scene.blend1')).toBe('text');
  expect(kindOf('scene.gltf.txt')).toBe('text');
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

it('modelUrl: a .blend goes through /model (converted by Blender), a glb / gltf through /file', () => {
  expect(modelUrl('m/a b.blend', 'here')).toBe('/model?path=m%2Fa%20b.blend');
  expect(modelUrl('m/a.BLEND', 'wt-1')).toBe('/model?path=m%2Fa.BLEND&src=wt-1');
  expect(modelUrl('m/a.glb', 'wt-1')).toBe('/file?path=m%2Fa.glb&src=wt-1');
});

it('kindOf: with experimental 3D off a model file is plain text, like any unsupported binary', () => {
  for (const p of ['m/robot.glb', 'ROBOT.GLB', 'scene.gltf', 'scene.blend']) expect([p, kindOf(p)]).toEqual([p, 'text']);
  setModel3d(true);
  expect(kindOf('scene.blend')).toBe('model');
  setModel3d(false);
  expect(kindOf('scene.blend')).toBe('text');
});
