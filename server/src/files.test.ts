import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInRoot, listDir, listFiles } from './files.ts';

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-files-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'file'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  fs.symlinkSync(path.join(base, 'nowhere'), path.join(root, 'dangling'));
  fs.mkdirSync(path.join(root, 'b'));
  fs.writeFileSync(path.join(root, 'Отчёт #1.md'), 'x');
  fs.writeFileSync(path.join(root, '%2e%2e'), 'literal');
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('resolveInRoot', () => {
  it('resolves inside the root, also with .. that stays inside', () => {
    expect(resolveInRoot(root, 'a/../b')).toBe(path.join(root, 'b'));
    expect(resolveInRoot(root, '')).toBe(root);
  });
  it('refuses escapes and absolute paths', () => {
    expect(resolveInRoot(root, '../x')).toBeNull();
    expect(resolveInRoot(root, '/etc/passwd')).toBeNull();
    expect(resolveInRoot(root, '..')).toBeNull();
    expect(resolveInRoot(root, 'a\0b')).toBeNull();
  });
  it('a file literally named %2e%2e is just a name (no second decode)', () => {
    expect(resolveInRoot(root, '%2e%2e')).toBe(path.join(root, '%2e%2e'));
  });
  it('refuses a symlink that leaves the root, even to a missing tail', () => {
    expect(resolveInRoot(root, 'link/file')).toBeNull();
    expect(resolveInRoot(root, 'link/new/deep')).toBeNull();
    expect(resolveInRoot(root, 'dangling')).toBeNull();
  });
  it('a tail that does not exist yet is fine inside the root', () => {
    expect(resolveInRoot(root, 'b/new/file.md')).toBe(path.join(root, 'b/new/file.md'));
  });
  it('a root that is itself a symlink works', () => {
    const viaLink = path.join(base, 'rootlink');
    fs.symlinkSync(root, viaLink);
    expect(resolveInRoot(viaLink, 'b')).toBe(path.join(viaLink, 'b'));
    expect(resolveInRoot(viaLink, 'link/file')).toBeNull();
  });
  it('resolves a Cyrillic name', () => {
    expect(resolveInRoot(root, 'Отчёт #1.md')).toBe(path.join(root, 'Отчёт #1.md'));
  });
});

describe('listDir / listFiles', () => {
  it('folders first, numeric order, hides .git and node_modules', async () => {
    const d = path.join(base, 'tree');
    fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.mkdirSync(path.join(d, 'z'));
    fs.writeFileSync(path.join(d, '10.md'), '');
    fs.writeFileSync(path.join(d, '2.md'), '');
    fs.writeFileSync(path.join(d, '.DS_Store'), '');
    expect(await listDir(d)).toEqual([
      { name: 'z', dir: true },
      { name: '2.md', dir: false },
      { name: '10.md', dir: false },
    ]);
  });
  it('listFiles is relative, slash-separated, skips hidden dirs', async () => {
    const d = path.join(base, 'lf');
    fs.mkdirSync(path.join(d, 'src/deep'), { recursive: true });
    fs.mkdirSync(path.join(d, 'node_modules'));
    fs.writeFileSync(path.join(d, 'node_modules/x.js'), '');
    fs.writeFileSync(path.join(d, 'src/deep/a.ts'), '');
    fs.writeFileSync(path.join(d, 'top.md'), '');
    expect((await listFiles(d)).sort()).toEqual(['src/deep/a.ts', 'top.md']);
  });
  it('listFiles skips symlinks to directories and ones leaving the root', async () => {
    const d = path.join(base, 'lf2');
    fs.mkdirSync(path.join(d, 'real'), { recursive: true });
    fs.writeFileSync(path.join(d, 'real/in.md'), '');
    fs.symlinkSync(path.join(d, 'real'), path.join(d, 'dirlink'));
    fs.symlinkSync(path.join(outside, 'file'), path.join(d, 'out.md'));
    fs.symlinkSync(path.join(d, 'real/in.md'), path.join(d, 'ok.md'));
    expect((await listFiles(d)).sort()).toEqual(['ok.md', 'real/in.md']);
  });
});
