// The e2e servers run with the access token on (the default). serve.mjs seeds each fixture's state dir with a known token and
// starts the server with a known launch nonce, so the config can hand every browser context what the page would hold after
// POST /auth: the HttpOnly cookie (read tier) and the key in localStorage (write tier, the socket).
// The formulas are server/src/auth.ts's (scripts/e2e-auth.test.ts checks the two agree).
import { createHash, createHmac } from 'node:crypto';

/** The fixture's token (serve.mjs writes the same into its state dir). */
export const e2eToken = (fixture: string): string => createHash('sha256').update(`nota-bene e2e ${fixture}`).digest('hex');
/** The fixture server's launch nonce (serve.mjs passes it as NOTA_BENE_NONCE). */
export const e2eNonce = (fixture: string): string => createHash('sha256').update(`nota-bene e2e nonce ${fixture}`).digest('hex').slice(0, 32);

const mac = (token: string, label: string, port: number, nonce: string): string =>
  createHmac('sha256', token).update(`nota-bene:${label}:${port}:${nonce}`).digest('hex');
export const e2eCookie = (fixture: string, port: number): string => mac(e2eToken(fixture), 'cookie', port, e2eNonce(fixture));
/** what the login URL carries (`#t=`): the login value of this launch, not the token */
export const e2eLogin = (fixture: string, port: number): string => mac(e2eToken(fixture), 'login', port, e2eNonce(fixture));
export const e2eKey = (fixture: string, port: number): string => mac(e2eToken(fixture), 'key', port, e2eNonce(fixture));

/** A Playwright storage state holding the login cookie and the page's key for `fixture`'s server. */
export function loggedIn(fixture: string, port: number) {
  return {
    cookies: [{
      name: `nb_${port}`, value: e2eCookie(fixture, port), domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' as const,
    }],
    origins: [{ origin: `http://127.0.0.1:${port}`, localStorage: [{ name: 'nb.key', value: e2eKey(fixture, port) }] }],
  };
}
