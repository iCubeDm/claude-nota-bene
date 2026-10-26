import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importPrototypeState, importPrototypeStateSafely } from './migrate.ts';
import { prefsKey, readPrefs, setModePref } from './prefs.ts';
import { lastSession, saveSession } from './state.ts';

let home: string;
let work: string;
let proto: string;
const prevHome = process.env.NOTA_BENE_HOME;
const rawPrefs = () => JSON.parse(fs.readFileSync(path.join(home, 'prefs.json'), 'utf8'));
const dir = (n: string) => {
  const d = path.join(work, n);
  fs.mkdirSync(d);
  return fs.realpathSync.native(d);
};
const writeProto = (o: unknown) => fs.writeFileSync(proto, typeof o === 'string' ? o : JSON.stringify(o));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-mig-home-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-mig-work-'));
  proto = path.join(work, 'proto-sessions.json');
  process.env.NOTA_BENE_HOME = home;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('importPrototypeState', () => {
  it('imports sessions and modes, sets the marker and logs once', () => {
    const a = dir('a');
    const b = dir('b');
    writeProto({ [a]: 's-a', [b]: 's-b', '_root:4777': a, '_mode:4777': 'plan', '_root:4778': b, '_mode:4778': 'acceptEdits' });
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 2, modes: 2 });
    expect(lastSession(a)).toBe('s-a');
    expect(lastSession(b)).toBe('s-b');
    expect(readPrefs().modes).toEqual({ [prefsKey(a)]: 'plan', [prefsKey(b)]: 'acceptEdits' });
    expect(rawPrefs().importedPrototype).toBe(true);
    expect(console.log).toHaveBeenCalledWith('imported from prototype: 2 sessions, 2 modes');
  });

  it('does not overwrite existing rebuild entries', () => {
    const a = dir('a');
    saveSession(a, 'mine');
    setModePref(a, 'default');
    writeProto({ [a]: 'old', '_root:4777': a, '_mode:4777': 'plan' });
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 0, modes: 0 });
    expect(lastSession(a)).toBe('mine');
    expect(readPrefs().modes[prefsKey(a)]).toBe('default');
  });

  it('the highest port wins when several ports map to one folder', () => {
    const a = dir('a');
    writeProto({ '_root:4777': a, '_mode:4777': 'plan', '_root:4779': a, '_mode:4779': 'default', '_root:4778': a, '_mode:4778': 'acceptEdits' });
    expect(importPrototypeState({ prototypeSessions: proto }).modes).toBe(1);
    expect(readPrefs().modes[prefsKey(a)]).toBe('default');
  });

  it('a second run is a no-op', () => {
    const a = dir('a');
    writeProto({ [a]: 's-a' });
    importPrototypeState({ prototypeSessions: proto });
    saveSession(a, 'newer');
    writeProto({ [a]: 's-a', [dir('c')]: 's-c' });
    vi.mocked(console.log).mockClear();
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 0, modes: 0 });
    expect(lastSession(a)).toBe('newer');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('a missing file still writes the marker, silently', () => {
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 0, modes: 0 });
    expect(rawPrefs().importedPrototype).toBe(true);
    expect(console.log).not.toHaveBeenCalled();
  });

  it('a corrupt file is skipped without throwing', () => {
    writeProto('{ not json');
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 0, modes: 0 });
    writeProto('[1,2]');
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 0, modes: 0 });
  });

  it('a corrupt file leaves no marker, so the next start retries', () => {
    const a = dir('a');
    writeProto('{ "x": ');
    importPrototypeState({ prototypeSessions: proto });
    expect(fs.existsSync(path.join(home, 'prefs.json'))).toBe(false);
    writeProto({ [a]: 's-a' });
    expect(importPrototypeState({ prototypeSessions: proto }).sessions).toBe(1);
  });

  it('a missing file keeps unknown prefs keys when it writes the marker', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ modes: {}, future: 7 }));
    importPrototypeState({ prototypeSessions: proto });
    expect(rawPrefs()).toMatchObject({ future: 7, importedPrototype: true });
  });

  it('a symlinked folder key merges with the realpath key', () => {
    const a = dir('a');
    const link = path.join(work, 'link');
    fs.symlinkSync(a, link);
    saveSession(a, 'mine');
    writeProto({ [link]: 'via-link', '_root:4777': link, '_mode:4777': 'plan' });
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 0, modes: 1 });
    expect(lastSession(a)).toBe('mine');
    expect(readPrefs().modes[prefsKey(a)]).toBe('plan');
  });

  it('the startup wrapper honours off and swallows failures', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    importPrototypeStateSafely({ NOTA_BENE_PROTOTYPE_SESSIONS: 'off' });
    expect(fs.existsSync(path.join(home, 'prefs.json'))).toBe(false);
    fs.writeFileSync(path.join(home, 'prefs.json'), '{ broken');
    fs.mkdirSync(path.join(home, 'sessions.json')); // a write failure
    writeProto({ [dir('a')]: 's' });
    expect(() => importPrototypeStateSafely({ NOTA_BENE_PROTOTYPE_SESSIONS: proto })).not.toThrow();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[migrate\] skipped: /));
  });

  it('skips folders that no longer exist and invalid modes, keeps unknown prefs keys', () => {
    const a = dir('a');
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ modes: {}, future: 7 }));
    writeProto({ [path.join(work, 'gone')]: 's-x', [a]: 's-a', '_root:4777': path.join(work, 'gone'), '_mode:4777': 'plan', '_root:4778': a, '_mode:4778': 'bogus', _other: 'x' });
    expect(importPrototypeState({ prototypeSessions: proto })).toEqual({ sessions: 1, modes: 0 });
    expect(rawPrefs().future).toBe(7);
    expect(lastSession(path.join(work, 'gone'))).toBeUndefined();
  });
});
