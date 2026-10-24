import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invocationCwd, parseArgs } from './main.ts';

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-main-')));
// --continue reads the session registry: keep it in a temp NOTA_BENE_HOME, never the real ~/.nota-bene
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-main-home-'));
const prevHome = process.env.NOTA_BENE_HOME;
beforeAll(() => { process.env.NOTA_BENE_HOME = home; });
afterAll(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('defaults: cwd and 4777', () => {
    expect(parseArgs([], cwd)).toEqual({
      dir: cwd,
      port: 4777,
      resume: undefined,
      continue: false,
      fake: undefined,
      allowOrigins: [],
    });
  });

  it('parses --port --resume --fake', () => {
    const r = parseArgs(['.', '--port', '4790', '--resume', 'abc', '--fake', 's.json'], cwd);
    expect(r).toMatchObject({ dir: cwd, port: 4790, resume: 'abc', fake: path.join(cwd, 's.json'), continue: false });
  });

  it('resolves --fake against the invocation cwd, like the project dir', () => {
    expect(parseArgs(['--fake', 'f/s.json'], cwd).fake).toBe(path.join(cwd, 'f/s.json'));
    expect(parseArgs(['--fake', '/abs/s.json'], cwd).fake).toBe('/abs/s.json');
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseArgs(['--port', 'x'], cwd)).toThrow(/usage/i);
  });

  it('collects repeatable --allow-origin and --continue', () => {
    const r = parseArgs(['--allow-origin', 'http://a', '--allow-origin', 'http://b', '--continue'], cwd);
    expect(r.allowOrigins).toEqual(['http://a', 'http://b']);
    expect(r.continue).toBe(true);
  });
});

describe('invocationCwd', () => {
  it('prefers npm INIT_CWD, else cwd', () => {
    expect(invocationCwd({ INIT_CWD: '/x' }, '/y')).toBe('/x');
    expect(invocationCwd({}, '/y')).toBe('/y');
  });
});
