import { describe, expect, it } from 'vitest';
import { devEnv } from './dev.mjs';

describe('devEnv', () => {
  it('defaults to ~/.nota-bene-dev and skips the prototype import', () => {
    const e = devEnv({ PATH: '/bin' }, '/home/u');
    expect(e.NOTA_BENE_HOME).toBe('/home/u/.nota-bene-dev');
    expect(e.NOTA_BENE_PROTOTYPE_SESSIONS).toBe('off');
    expect(e.PATH).toBe('/bin');
  });

  it('respects values already set', () => {
    const e = devEnv({ NOTA_BENE_HOME: '/x', NOTA_BENE_PROTOTYPE_SESSIONS: 'on' }, '/home/u');
    expect(e.NOTA_BENE_HOME).toBe('/x');
    expect(e.NOTA_BENE_PROTOTYPE_SESSIONS).toBe('on');
  });

  it('treats empty values as unset', () => {
    expect(devEnv({ NOTA_BENE_HOME: '' }, '/h').NOTA_BENE_HOME).toBe('/h/.nota-bene-dev');
  });
});
