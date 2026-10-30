import { expect, it } from 'vitest';
import { portCredential } from '../server/src/auth.ts';
import { e2eCredential, e2eToken } from '../e2e/auth.ts';

// e2e/auth.ts builds the browsers' login cookie without importing the server: its copy of the formula must not drift
it('the e2e login cookie uses the server\'s credential formula', () => {
  expect(e2eCredential('c'.repeat(64), 4791)).toBe(portCredential('c'.repeat(64), 4791));
  expect(e2eToken('chat')).toMatch(/^[0-9a-f]{64}$/);
  expect(e2eToken('chat')).not.toBe(e2eToken('slow'));
});
