import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prefsKey, readPrefs, setIdleCompactPref, setModePref, setModelPref } from './prefs.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-prefs-'));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('prefs', () => {
  it('ignores the retired importedPrototype key and keeps it on write', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ importedPrototype: true, modes: { [prefsKey('/a')]: 'plan' } }));
    expect(readPrefs().modes[prefsKey('/a')]).toBe('plan');
    setIdleCompactPref('/b', true);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'prefs.json'), 'utf8')).importedPrototype).toBe(true);
  });

  it('defaults when the file is missing', () => {
    expect(readPrefs()).toEqual({ modes: {}, models: {}, idleCompact: {} });
  });
  it('stores a mode per project dir and keeps the others', () => {
    setModePref('/a', 'plan');
    setModePref('/b', 'default');
    expect(readPrefs().modes).toEqual({ [prefsKey('/a')]: 'plan', [prefsKey('/b')]: 'default' });
  });
  it('a symlinked dir shares the real dir key', () => {
    fs.mkdirSync(path.join(home, 'real'));
    fs.symlinkSync(path.join(home, 'real'), path.join(home, 'link'));
    setModePref(path.join(home, 'link'), 'acceptEdits');
    expect(readPrefs().modes[prefsKey(path.join(home, 'real'))]).toBe('acceptEdits');
  });
  it('corrupt file falls back to defaults and is overwritten by the next save', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), '{');
    expect(readPrefs()).toEqual({ modes: {}, models: {}, idleCompact: {} });
    setModePref('/a', 'plan');
    expect(readPrefs().modes[prefsKey('/a')]).toBe('plan');
  });
  it('drops unknown mode values', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ modes: { '/a': 'bogus', '/b': 'plan' }, lang: 'en' }));
    expect(readPrefs()).toEqual({ modes: { '/b': 'plan' }, models: {}, lang: 'en', idleCompact: {} });
  });
  it('stores a model with its effort per project, keeps the others and the modes, drops an empty effort', () => {
    setModePref('/a', 'plan');
    setModelPref('/a', { model: 'opus', effort: 'high' });
    setModelPref('/b', { model: 'sonnet' });
    setModelPref('/b', { model: 'haiku' });
    expect(readPrefs().models).toEqual({ [prefsKey('/a')]: { model: 'opus', effort: 'high' }, [prefsKey('/b')]: { model: 'haiku' } });
    expect(readPrefs().modes[prefsKey('/a')]).toBe('plan');
  });
  it('drops malformed model entries and unknown efforts on read', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ models: { '/a': 'opus', '/b': { model: '' }, '/c': { model: 'x', effort: 'ultra' }, '/d': { model: 'y', effort: 'max' } } }));
    expect(readPrefs().models).toEqual({ '/c': { model: 'x' }, '/d': { model: 'y', effort: 'max' } });
  });
  it('leaves no tmp file', () => {
    setModePref('/a', 'plan');
    expect(fs.readdirSync(home).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
  it('a mode save keeps unknown top-level keys and other projects entries', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ future: { x: 1 }, lang: 'ru', modes: { '/old': 'plan', '/odd': 'bogus' } }));
    setModePref('/a', 'default');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'prefs.json'), 'utf8'))).toEqual({
      future: { x: 1 }, lang: 'ru', modes: { '/old': 'plan', '/odd': 'bogus', [prefsKey('/a')]: 'default' },
    });
  });
  it('idle compaction is stored per project, keeps the modes, and drops non-boolean values', () => {
    setModePref('/a', 'plan');
    setIdleCompactPref('/a', false);
    setIdleCompactPref('/b', true);
    expect(readPrefs()).toMatchObject({ modes: { [prefsKey('/a')]: 'plan' }, idleCompact: { [prefsKey('/a')]: false, [prefsKey('/b')]: true } });
    fs.writeFileSync(path.join(home, 'prefs.json'), JSON.stringify({ modes: {}, idleCompact: { '/x': 'no', '/y': false } }));
    expect(readPrefs().idleCompact).toEqual({ '/y': false });
  });
  it('keeps a copy of a corrupt file before replacing it', () => {
    fs.writeFileSync(path.join(home, 'prefs.json'), '{ broken');
    setModePref('/a', 'plan');
    expect(fs.readFileSync(path.join(home, 'prefs.json.corrupt'), 'utf8')).toBe('{ broken');
  });
});
