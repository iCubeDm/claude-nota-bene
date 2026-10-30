import { afterEach, expect, it } from 'vitest';
import { isTmpImagePath, isTmpTabPath, setTmpDirs, tmpImagePathsIn, tmpImageUrl } from './tmpImages.ts';

afterEach(() => setTmpDirs([]));

it('nothing is a temp image until the server names its temp folders', () => {
  expect(isTmpImagePath('/tmp/a.png')).toBe(false);
  setTmpDirs(['/tmp', '/private/tmp', '/var/folders/x/T/']);
  expect(isTmpImagePath('/tmp/a.png')).toBe(true);
  expect(isTmpImagePath('/var/folders/x/T/sub/b.JPG')).toBe(true);
});

it('images only, lexically inside a folder, no `..`, no odd characters', () => {
  setTmpDirs(['/tmp']);
  for (const p of ['/tmp/a.txt', '/tmp/a', '/tmp/', '/tmp.png', '/tmpx/a.png', '/tmp/../etc/a.png', '/tmp/./a.png', '/etc/a.png', 'tmp/a.png', '//tmp/a.png', '/tmp/a|b.png', '/tmp/a.png.sh', '/tmp/a.mp4']) {
    expect(isTmpImagePath(p), p).toBe(false);
  }
  for (const p of ['/tmp/a.png', '/tmp/s/a.jpeg', '/tmp/a b.webp', '/tmp/a.avif', '/tmp/a.bmp', '/tmp/a.svg', '/tmp/a.gif']) expect(isTmpImagePath(p), p).toBe(true);
});

it('finds the paths in a command or an argument, once each', () => {
  setTmpDirs(['/tmp']);
  expect(tmpImagePathsIn('screencapture -x /tmp/shot.png && open "/tmp/shot.png" /tmp/other.jpg /home/u/p.png')).toEqual(['/tmp/shot.png', '/tmp/other.jpg']);
  expect(tmpImagePathsIn('/tmp/only.png')).toEqual(['/tmp/only.png']);
  expect(tmpImagePathsIn('cat /tmp/a.txt')).toEqual([]);
});

it('a tab path is a temp image when it is absolute; the url encodes it and may bust the cache', () => {
  expect(isTmpTabPath('/tmp/a.png')).toBe(true);
  expect(isTmpTabPath('img/a.png')).toBe(false);
  expect(isTmpTabPath('/tmp/a.txt')).toBe(false);
  expect(tmpImageUrl('/tmp/a b.png')).toBe('/tmpimage?path=%2Ftmp%2Fa%20b.png');
  expect(tmpImageUrl('/tmp/a.png', 2)).toBe('/tmpimage?path=%2Ftmp%2Fa.png&r=2');
});
