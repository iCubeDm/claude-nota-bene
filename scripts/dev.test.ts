import { describe, expect, it } from 'vitest';
import { devEnv, devNonce } from './dev.mjs';

describe('devEnv', () => {
  it('defaults to ~/.nota-bene-dev', () => {
    const e = devEnv({ PATH: '/bin' }, '/home/u');
    expect(e.NOTA_BENE_HOME).toBe('/home/u/.nota-bene-dev');
    expect(e.PATH).toBe('/bin');
  });

  it('respects values already set', () => {
    expect(devEnv({ NOTA_BENE_HOME: '/x' }, '/home/u').NOTA_BENE_HOME).toBe('/x');
  });

  it('treats empty values as unset', () => {
    expect(devEnv({ NOTA_BENE_HOME: '' }, '/h').NOTA_BENE_HOME).toBe('/h/.nota-bene-dev');
  });
});

describe('devNonce', () => {
  it('is a 32-hex launch nonce (made once per `npm run dev`, so a watch reload keeps the login)', () => {
    expect(devNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(devNonce()).not.toBe(devNonce());
  });
  it('dev.mjs hands one nonce to both commands through the shared env', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./dev.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/const env = \{ \.\.\.devEnv\(process\.env, os\.homedir\(\)\), NOTA_BENE_NONCE: devNonce\(\) \}/);
  });
});
