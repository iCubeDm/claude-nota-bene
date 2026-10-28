import { describe, expect, it } from 'vitest';
import { devEnv } from './dev.mjs';

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
