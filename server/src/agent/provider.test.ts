import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProvider, providerStateDir } from './provider.ts';
import { stateDir, saveSession, lastSession } from '../state.ts';
import { underState } from '../stateGuard.ts';
import { parseArgs } from '../main.ts';
// @ts-expect-error plain launcher ESM has no declarations
import { parseArgs as launchArgs, serverArgs } from '../../../bin/nota-bene.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('provider identity', () => {
  it('keeps Claude as the default and rejects unknown providers', () => {
    expect(parseProvider(undefined)).toBe('claude');
    expect(parseProvider('codex')).toBe('codex');
    expect(() => parseProvider('../codex')).toThrow(/agent/i);
  });

  it('keeps legacy state exactly where it was and isolates Codex', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-provider-'));
    try {
      vi.stubEnv('NOTA_BENE_HOME', base);
      vi.stubEnv('NOTA_BENE_AGENT', 'claude');
      expect(stateDir()).toBe(base);
      saveSession('/project', 'claude-session');
      vi.stubEnv('NOTA_BENE_AGENT', 'codex');
      expect(stateDir()).toBe(providerStateDir(base, 'codex'));
      expect(lastSession('/project')).toBeUndefined();
      saveSession('/project', 'codex-session');
      expect(underState(path.join(base, 'token'))).toBe(true);
      expect(underState(path.join(stateDir(), 'token'))).toBe(true);
      vi.stubEnv('NOTA_BENE_AGENT', 'claude');
      expect(lastSession('/project')).toBe('claude-session');
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('passes explicit selection through the launcher, including relaunch', () => {
    const args = launchArgs(['.', '--agent', 'codex']);
    expect(args.agent).toBe('codex');
    expect(serverArgs({ ...args, dir: '/project' }, 4790, false)).toContain('codex');
    expect(serverArgs({ ...args, dir: '/project' }, 4790, true)).toEqual(['/project', '--port', '4790', '--agent', 'codex', '--continue']);
    expect(parseArgs(['--agent', 'codex'], process.cwd()).agent).toBe('codex');
    expect(() => launchArgs(['--agent', 'other'])).toThrow(/agent/i);
    expect(() => parseArgs(['--agent', 'other'], process.cwd())).toThrow(/agent/i);
  });
});
