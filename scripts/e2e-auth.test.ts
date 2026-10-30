import { expect, it } from 'vitest';
import { cookieCredential, keyCredential, loginCredential } from '../server/src/auth.ts';
import { e2eCookie, e2eKey, e2eLogin, e2eNonce, e2eToken } from '../e2e/auth.ts';

// e2e/auth.ts builds the browsers' login (cookie + key) without importing the server: its copy of the formulas must not drift
it('the e2e login uses the server\'s formulas', () => {
  const t = e2eToken('chat');
  expect(e2eCookie('chat', 4791)).toBe(cookieCredential(t, 4791, e2eNonce('chat')));
  expect(e2eKey('chat', 4791)).toBe(keyCredential(t, 4791, e2eNonce('chat')));
  expect(e2eLogin('chat', 4791)).toBe(loginCredential(t, 4791, e2eNonce('chat')));
  expect(t).toMatch(/^[0-9a-f]{64}$/);
  expect(e2eNonce('chat')).toMatch(/^[0-9a-f]{32}$/);
  expect(e2eToken('chat')).not.toBe(e2eToken('slow'));
});
