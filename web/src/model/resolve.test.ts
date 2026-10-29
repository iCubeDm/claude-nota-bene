import { expect, it } from 'vitest';
import { resolveModelUrl } from './resolve.ts';

const u = (p: string) => `/file?path=${encodeURIComponent(p)}`;

it('a relative uri resolves against the model file directory', () => {
  expect(resolveModelUrl('scene.bin', 'models/car')).toBe(u('models/car/scene.bin'));
  expect(resolveModelUrl('./tex/a b.png', 'models')).toBe(u('models/tex/a b.png'));
  expect(resolveModelUrl('tex/a%20b.png', 'models')).toBe(u('models/tex/a b.png'));
});

it('../ folds, and a model at the project root has no directory', () => {
  expect(resolveModelUrl('../shared/t.png', 'models/car')).toBe(u('models/shared/t.png'));
  expect(resolveModelUrl('scene.bin', undefined)).toBe(u('scene.bin'));
});

it('climbing above the root is left to the server (403), not clamped', () => {
  expect(resolveModelUrl('../../x.bin', 'models')).toBe(u('models/../../x.bin'));
});

it('src is carried to every resource, "here" is the default', () => {
  expect(resolveModelUrl('s.bin', 'm', 'wt-1')).toBe(`${u('m/s.bin')}&src=wt-1`);
  expect(resolveModelUrl('s.bin', 'm', 'here')).toBe(u('m/s.bin'));
});

it('data: and blob: uris stay as they are', () => {
  expect(resolveModelUrl('data:application/octet-stream;base64,AAAA', 'm', 'x')).toBe('data:application/octet-stream;base64,AAAA');
  expect(resolveModelUrl('blob:http://h/1234', 'm')).toBe('blob:http://h/1234');
});

it('an absolute http(s) or protocol-relative uri is refused: nothing leaves our server', () => {
  expect(resolveModelUrl('https://evil.example/t.png', 'm')).toBeNull();
  expect(resolveModelUrl('http://evil.example/t.png', 'm')).toBeNull();
  expect(resolveModelUrl('//evil.example/t.png', 'm')).toBeNull();
});

it('a leading slash is the project-relative path the server will judge, like fileUrl', () => {
  expect(resolveModelUrl('/abs/t.png', 'm')).toBe(u('/abs/t.png'));
});
