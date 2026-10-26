import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
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
    expect(await listDir(d, d)).toEqual([
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
    expect((await listFiles(d)).sort()).toEqual(['src/', 'src/deep/', 'src/deep/a.ts', 'top.md']);
  });
  it('listFiles skips symlinks to directories and ones leaving the root', async () => {
    const d = path.join(base, 'lf2');
    fs.mkdirSync(path.join(d, 'real'), { recursive: true });
    fs.writeFileSync(path.join(d, 'real/in.md'), '');
    fs.symlinkSync(path.join(d, 'real'), path.join(d, 'dirlink'));
    fs.symlinkSync(path.join(outside, 'file'), path.join(d, 'out.md'));
    fs.symlinkSync(path.join(d, 'real/in.md'), path.join(d, 'ok.md'));
    expect((await listFiles(d)).sort()).toEqual(['ok.md', 'real/', 'real/in.md']);
  });
  it('listFiles skips build output and caches', async () => {
    const d = path.join(base, 'lf3');
    for (const n of ['dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache', 'keep']) {
      fs.mkdirSync(path.join(d, n), { recursive: true });
      fs.writeFileSync(path.join(d, n, 'f.txt'), '');
    }
    expect((await listFiles(d)).sort()).toEqual(['keep/', 'keep/f.txt']);
  });
  it('listFiles (walk and git) hides the .nota-bene marks folder; the tree still shows it', async () => {
    const d = path.join(base, 'lf-nb');
    fs.mkdirSync(path.join(d, '.nota-bene/marks/m1'), { recursive: true });
    fs.writeFileSync(path.join(d, '.nota-bene/marks/m1/frame.jpg'), '');
    fs.writeFileSync(path.join(d, 'top.md'), '');
    expect((await listFiles(d)).sort()).toEqual(['top.md']);
    expect(await listDir(d, d)).toContainEqual({ name: '.nota-bene', dir: true });
    const g = path.join(base, 'lf-nb-git'); // a repo where the marks folder is not ignored (no .nota-bene/.gitignore)
    fs.mkdirSync(path.join(g, '.nota-bene/marks/m1'), { recursive: true });
    fs.writeFileSync(path.join(g, '.nota-bene/marks/m1/layer.png'), '');
    fs.writeFileSync(path.join(g, 'a.md'), '');
    execFileSync('git', ['init'], { cwd: g, stdio: 'ignore' });
    expect((await listFiles(g)).sort()).toEqual(['a.md']);
  });
  it('listFiles uses git ls-files in a repo: untracked yes, ignored and deleted no', async () => {
    const d = path.join(base, 'lf4');
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, '.gitignore'), 'ignored.md\ndist\n');
    fs.writeFileSync(path.join(d, 'src/a.ts'), '');
    fs.writeFileSync(path.join(d, 'gone.md'), '');
    fs.writeFileSync(path.join(d, 'ignored.md'), '');
    fs.writeFileSync(path.join(d, 'Отчёт.md'), '');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, stdio: 'ignore' });
    git('init');
    git('add', 'gone.md', 'src/a.ts');
    fs.rmSync(path.join(d, 'gone.md'));
    fs.writeFileSync(path.join(d, 'new.md'), '');
    expect((await listFiles(d)).sort()).toEqual(['.gitignore', 'src/', 'src/a.ts', 'new.md', 'Отчёт.md'].sort());
  });
  it('git output: build dirs are dropped even without a .gitignore', async () => {
    const d = path.join(base, 'lf5');
    for (const n of ['node_modules/p', 'src/.venv', 'dist', 'src']) fs.mkdirSync(path.join(d, n), { recursive: true });
    for (const f of ['node_modules/p/i.js', 'src/.venv/x.py', 'dist/o.js', 'src/a.ts', 'top.md']) fs.writeFileSync(path.join(d, f), '');
    execFileSync('git', ['init'], { cwd: d, stdio: 'ignore' });
    expect((await listFiles(d)).sort()).toEqual(['src/', 'src/a.ts', 'top.md']);
  });
  it('a repo where git lists nothing falls back to the walk', async () => {
    const d = path.join(base, 'lf6');
    fs.mkdirSync(path.join(d, 'a'), { recursive: true });
    fs.writeFileSync(path.join(d, '.gitignore'), '*\n'); // ignores everything, itself included: ls-files prints nothing
    fs.writeFileSync(path.join(d, 'a/f.md'), '');
    execFileSync('git', ['init'], { cwd: d, stdio: 'ignore' });
    expect((await listFiles(d)).sort()).toEqual(['.gitignore', 'a/', 'a/f.md']);
  });
  it('serves the stale list after the TTL and refreshes in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const d = path.join(base, 'lf7');
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'one.md'), '');
      expect(await listFiles(d)).toEqual(['one.md']);
      fs.writeFileSync(path.join(d, 'two.md'), '');
      vi.setSystemTime(Date.now() + 11_000);
      expect(await listFiles(d)).toEqual(['one.md']); // stale, instantly
      await vi.waitFor(async () => expect((await listFiles(d)).sort()).toEqual(['one.md', 'two.md']));
    } finally {
      vi.useRealTimers();
    }
  });
});
