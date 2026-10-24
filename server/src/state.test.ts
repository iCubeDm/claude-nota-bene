import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { lastSession, saveSession, stateDir } from './state.ts';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-state-'));
  process.env.NOTA_BENE_HOME = home;
});

describe('state', () => {
  it('saves then reads a session id', () => {
    saveSession('/p', 'abc');
    expect(lastSession('/p')).toBe('abc');
  });
  it('null deletes the entry', () => {
    saveSession('/p', 'abc');
    saveSession('/p', null);
    expect(lastSession('/p')).toBeUndefined();
  });
  it('corrupt sessions.json yields undefined without throwing', () => {
    fs.writeFileSync(path.join(stateDir(), 'sessions.json'), '{');
    expect(lastSession('/p')).toBeUndefined();
  });
  it('leaves no sessions.json.tmp* after a save', () => {
    saveSession('/p', 'abc');
    expect(fs.readdirSync(home).filter((f) => f.startsWith('sessions.json.tmp'))).toEqual([]);
  });
});
