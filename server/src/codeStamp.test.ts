import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { TTL_MS, codeChecker } from './codeStamp.ts';

let repo: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-codestamp-'));
  for (const d of ['server', 'shared']) fs.mkdirSync(path.join(repo, d, 'src', 'sub'), { recursive: true });
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const START = 1_000_000_000_000;
const touch = (rel: string, mtimeMs: number) => {
  const p = path.join(repo, rel);
  fs.writeFileSync(p, '');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
};
function make() {
  let t = START;
  const check = codeChecker({ repoDir: repo, startedAt: START, now: () => t });
  return { check, advance: (ms: number) => { t += ms; } };
}

it('nothing touched after the start is not a change', () => {
  touch('server/src/a.ts', START - 1000);
  expect(make().check()).toBe(false);
});

it('a .ts touched after the start, in server or shared (nested too), is a change', () => {
  touch('server/src/sub/a.ts', START + 1000);
  expect(make().check()).toBe(true);
  fs.rmSync(path.join(repo, 'server/src/sub/a.ts'));
  touch('shared/src/b.ts', START + 1000);
  expect(make().check()).toBe(true);
});

it('only a *.test.ts or a non-ts file touched is not a change', () => {
  touch('server/src/a.test.ts', START + 1000);
  touch('shared/src/notes.md', START + 1000);
  expect(make().check()).toBe(false);
});

it('a missing dir is not a change and does not throw', () => {
  fs.rmSync(path.join(repo, 'shared'), { recursive: true });
  expect(make().check()).toBe(false);
});

it('caches a "no" for the ttl, then rescans; once true it stays true without scanning', () => {
  const { check, advance } = make();
  expect(check()).toBe(false);
  touch('server/src/a.ts', START + 1000);
  advance(TTL_MS - 1);
  expect(check()).toBe(false); // cached
  advance(2);
  expect(check()).toBe(true);
  fs.rmSync(path.join(repo, 'server/src/a.ts'));
  expect(check()).toBe(true); // sticky
});
