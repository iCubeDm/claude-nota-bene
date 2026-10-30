// The e2e servers run with the access token on (the default). serve.mjs seeds each fixture's state dir with a known token, so the
// config can hand every browser context the login cookie the page would have got from POST /auth.
// The credential formula is server/src/auth.ts's portCredential (server/src/auth.test.ts checks the two agree).
import { createHash, createHmac } from 'node:crypto';

/** The fixture's token (serve.mjs writes the same into its state dir). */
export const e2eToken = (fixture: string): string => createHash('sha256').update(`nota-bene e2e ${fixture}`).digest('hex');

export const e2eCredential = (token: string, port: number): string =>
  createHmac('sha256', token).update(`nota-bene:port:${port}`).digest('hex');

/** A Playwright storage state holding the login cookie of `fixture`'s server. */
export function loggedIn(fixture: string, port: number) {
  return {
    cookies: [{
      name: `nb_${port}`, value: e2eCredential(e2eToken(fixture), port), domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' as const,
    }],
    origins: [],
  };
}
