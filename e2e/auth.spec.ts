import { expect, test } from '@playwright/test';
import { e2eCookie, e2eToken, loggedIn } from './auth.ts';

// The login (B1d): a window opened on `/#t=<token>` trades it for the cookie; a page with no login says how to reopen the
// window instead of reconnecting forever. Runs on the chat fixture (4791), in fresh contexts without the config's cookie.
const PORT = 4791;
const overlay = (p: import('@playwright/test').Page) => p.getByTestId('login-required');

test('a page with no login shows the overlay and stops reconnecting @chat', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, locale: 'en-US', storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  let sockets = 0;
  page.on('websocket', () => sockets++);
  await page.goto('/');
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toContainText('/nb');
  const seen = sockets;
  await page.waitForTimeout(3500); // three would-be retries
  expect(sockets).toBe(seen);
  await ctx.close();
});

test('the URL fragment logs in, is taken out of the address bar, and the window works @chat', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, locale: 'en-US', storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`/#t=${e2eToken('chat')}`);
  await expect(page.locator('#composer-input')).toBeEnabled();
  await expect(overlay(page)).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe('');
  const cookie = (await ctx.cookies()).find((c) => c.name === `nb_${PORT}`)!;
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(cookie.value).not.toBe(e2eToken('chat')); // the cookie is the port's credential, not the token
  expect(await page.evaluate(() => document.cookie)).not.toContain('nb_'); // HttpOnly: the page cannot read it
  expect(await page.evaluate(() => localStorage.getItem('nb.key'))).toMatch(/^[0-9a-f]{64}$/); // the key that opens the socket and writes
  // images and media are plain subresource loads: the cookie goes with them
  expect((await ctx.request.get('/info')).status()).toBe(200);
  await ctx.close();
});

test('a wrong token in the fragment is the same overlay @chat', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, locale: 'en-US', storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`/#t=${'0'.repeat(64)}`);
  await expect(overlay(page)).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect((await ctx.cookies()).length).toBe(0);
  await ctx.close();
});

test('the API and the socket refuse a request without the cookie, even from our own origin @chat', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, locale: 'en-US', storageState: { cookies: [], origins: [] } });
  expect((await ctx.request.get('/info')).status()).toBe(401);
  expect((await ctx.request.get('/file?path=README.md')).status()).toBe(401);
  expect((await ctx.request.post('/restart-server', { headers: { origin: baseURL! } })).status()).toBe(401);
  expect((await ctx.request.get('/')).status()).toBe(200); // the app shell is public
  await ctx.close();
});

test('the cookie alone (no key in the page) reads files but cannot open the socket or write: the overlay @chat', async ({ browser, baseURL }) => {
  const cookieOnly = { cookies: loggedIn('chat', PORT).cookies, origins: [] };
  const ctx = await browser.newContext({ baseURL, locale: 'en-US', storageState: cookieOnly });
  expect((await ctx.request.get('/info')).status()).toBe(200);
  expect((await ctx.request.get('/file?path=README.md')).status()).not.toBe(401);
  // a write with the cookie and the page's own Origin, as a program that got the cookie would send it
  expect((await ctx.request.post('/restart-server', { headers: { origin: baseURL! } })).status()).toBe(401);
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(overlay(page)).toBeVisible();
  expect(e2eCookie('chat', PORT)).not.toBe(e2eToken('chat'));
  await ctx.close();
});
