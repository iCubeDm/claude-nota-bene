import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invocationCwd, launchTarget, parseArgs, stateLine } from './main.ts';
import { saveSession } from './state.ts';

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
      fork: false,
      new: false,
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

describe('launch options', () => {
  it('parses --fork and --new, and rejects --fork without --resume and --new with --resume', () => {
    expect(parseArgs(['--resume', 'a', '--fork'], cwd)).toMatchObject({ resume: 'a', fork: true });
    expect(parseArgs(['--new'], cwd)).toMatchObject({ new: true });
    expect(() => parseArgs(['--fork'], cwd)).toThrow(/--fork needs --resume/);
    expect(() => parseArgs(['--new', '--resume', 'a'], cwd)).toThrow(/--new/);
  });

  describe('launchTarget', () => {
    const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-main-projects-'));
    fs.mkdirSync(path.join(projects, 'p1'));
    fs.writeFileSync(path.join(projects, 'p1', 'saved-id.jsonl'), '{}\n');
    afterAll(() => fs.rmSync(projects, { recursive: true, force: true }));
    const args = (extra: string[] = []) => parseArgs(extra, cwd);

    it('default resumes the saved session when its transcript exists', () => {
      saveSession(cwd, 'saved-id');
      expect(launchTarget(args(), projects)).toEqual({ resume: 'saved-id' });
      expect(launchTarget(args(['--continue']), projects)).toEqual({ resume: 'saved-id' });
    });

    it('default starts new when the transcript is gone, or nothing is saved', () => {
      saveSession(cwd, 'gone-id');
      expect(launchTarget(args(), projects)).toEqual({});
      saveSession(cwd, null);
      expect(launchTarget(args(), projects)).toEqual({});
    });

    it('--new ignores the saved session', () => {
      saveSession(cwd, 'saved-id');
      expect(launchTarget(args(['--new']), projects)).toEqual({});
    });

    it('--resume wins over the saved session, and --fork rides along', () => {
      saveSession(cwd, 'saved-id');
      expect(launchTarget(args(['--resume', 'other']), projects)).toEqual({ resume: 'other' });
      expect(launchTarget(args(['--resume', 'other', '--fork']), projects)).toEqual({ resume: 'other', fork: true });
    });
  });
});

describe('invocationCwd', () => {
  it('prefers npm INIT_CWD, else cwd', () => {
    expect(invocationCwd({ INIT_CWD: '/x' }, '/y')).toBe('/x');
    expect(invocationCwd({}, '/y')).toBe('/y');
  });
});

describe('stateLine', () => {
  it('names the state dir taken from NOTA_BENE_HOME', () => {
    expect(stateLine()).toBe(`state: ${home}`);
  });
});
