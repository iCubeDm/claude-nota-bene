import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { PACKAGE_NAME, prepareOut } from './build-package.mjs';

const SCRIPT = fileURLToPath(new URL('./build-package.mjs', import.meta.url));
let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-prep-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it('--out without a value is an error and removes nothing (cwd is left alone)', () => {
  fs.writeFileSync(path.join(tmp, 'keep.txt'), 'x');
  for (const args of [['--out'], ['--out', ''], ['--out', '--skip-web']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, encoding: 'utf8' });
    expect([args, r.status]).toEqual([args, 2]);
    expect(r.stderr).toContain('--out needs a directory');
  }
  expect(fs.readFileSync(path.join(tmp, 'keep.txt'), 'utf8')).toBe('x');
});

it('prepareOut: creates a missing dir, accepts an empty one, refuses a non-empty foreign one untouched', () => {
  const fresh = path.join(tmp, 'a/b');
  prepareOut(fresh);
  expect(fs.readdirSync(fresh)).toEqual([]);
  prepareOut(fresh);
  const foreign = path.join(tmp, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ name: 'nota-bene' }));
  fs.writeFileSync(path.join(foreign, 'precious'), 'x');
  expect(() => prepareOut(foreign)).toThrow(/refusing/);
  expect(fs.existsSync(path.join(foreign, 'precious'))).toBe(true);
  const file = path.join(tmp, 'f');
  fs.writeFileSync(file, '');
  expect(() => prepareOut(file)).toThrow(/not a directory/);
});

it('prepareOut: a previous build is moved away (to the Trash), not deleted in place, and the dir comes back empty', () => {
  const prev = path.join(tmp, 'pkg');
  fs.mkdirSync(prev);
  fs.writeFileSync(path.join(prev, 'package.json'), JSON.stringify({ name: PACKAGE_NAME }));
  fs.writeFileSync(path.join(prev, 'old.js'), 'x');
  prepareOut(prev);
  expect(fs.readdirSync(prev)).toEqual([]);
});
