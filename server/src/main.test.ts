import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { invocationCwd, parseArgs } from './main.ts';

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-main-')));

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
    expect(r).toMatchObject({ dir: cwd, port: 4790, resume: 'abc', fake: 's.json', continue: false });
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
