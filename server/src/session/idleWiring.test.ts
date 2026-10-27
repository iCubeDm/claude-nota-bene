import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_CAPABILITIES } from '@nota-bene/shared';
import { setIdleCompactPref } from '../prefs.ts';
import { idleCompaction } from './idleWiring.ts';

let home: string;
const prevHome = process.env.NOTA_BENE_HOME;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-idlew-')));
  process.env.NOTA_BENE_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const config = { afterMs: 120_000, awayMs: 60_000, retryMs: 30, cacheMs: 5000, minTokens: 100 };
const make = (o: { blocked?: boolean; caps?: Partial<typeof CLAUDE_CAPABILITIES>; root?: string } = {}) =>
  idleCompaction({
    config, offInSettings: () => o.blocked ?? false, root: () => o.root ?? '/p',
    capabilities: { ...CLAUDE_CAPABILITIES, ...o.caps }, busy: () => false, contextUsed: () => 1000, compact: () => {},
  });

describe('idleCompaction', () => {
  it('the state: on by default per project, the settings block, the timing in minutes', () => {
    const { state } = make();
    expect(state()).toEqual({ on: true, blocked: false, minutes: 2, awayMinutes: 1, minTokens: 100 });
    setIdleCompactPref('/p', false);
    expect(state().on).toBe(false);
    expect(make({ root: '/other' }).state().on).toBe(true);
    expect(make({ blocked: true }).state().blocked).toBe(true);
  });

  it('enabled only with both capabilities, on, and not blocked', () => {
    expect(make().enabled()).toBe(true);
    expect(make({ blocked: true }).enabled()).toBe(false);
    expect(make({ caps: { idleCompact: false } }).enabled()).toBe(false);
    expect(make({ caps: { compact: false } }).enabled()).toBe(false);
    setIdleCompactPref('/p', false);
    expect(make().enabled()).toBe(false);
  });
});
