import { expect, test, type Page } from '@playwright/test';

// M7-15 (R-M7-5…8): one tab owns the window. Runs on the chat fixture (4791); every page a test opens is closed at its end,
// so the next test's page finds the window free (a socket that arrives while the old one is still closing waits the 700 ms grace).
const composer = (page: Page) => page.locator('#composer-input');
const overlay = (page: Page) => page.getByTestId('onetab');
const workHere = (page: Page) => page.getByRole('button', { name: 'Work here' });
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const bubble = (page: Page, text: string) => page.locator('[data-kind="user"]').filter({ hasText: text });
const FAV_IDLE = '#6b7280';
const FAV_ERROR = '#e5484d';

async function open(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await expect(overlay(page)).toHaveCount(0);
}
const favFill = (page: Page) => page.evaluate(() => decodeURIComponent(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href));

test('a second page sees the occupied overlay, inert app and grey favicon; the owner is untouched @chat', async ({ page, context }) => {
  await open(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(overlay(second)).toHaveAttribute('data-state', 'occupied');
  await expect(overlay(second)).toContainText('The window is already open in another tab');
  await expect(workHere(second)).toBeVisible();
  // the app is mounted but inert under the overlay
  expect(await composer(second).evaluate((el) => !!el.closest('[inert]'))).toBe(true);
  const icon = await favFill(second);
  expect(icon).toContain(FAV_IDLE);
  expect(icon).not.toContain(FAV_ERROR);
  await expect(overlay(page)).toHaveCount(0);
  await expect(composer(page)).toBeEnabled();
  await second.close();
});

test('«Работать здесь» moves the session; the first page shows taken and does not reconnect by itself @chat', async ({ page, context }) => {
  await open(page);
  const text = uniq('before takeover');
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(bubble(page, text)).toBeVisible();
  await expect(page.locator('[data-kind="done"]').last()).toBeVisible();

  const second = await context.newPage();
  await second.goto('/');
  await workHere(second).click();
  await expect(overlay(second)).toHaveCount(0);
  await expect(bubble(second, text)).toBeVisible(); // the replay came with the takeover
  await expect(composer(second)).toBeEnabled();

  await expect(overlay(page)).toHaveAttribute('data-state', 'taken');
  await expect(overlay(page)).toContainText('Open in another tab');
  expect(await favFill(page)).not.toContain(FAV_ERROR);
  // it stays parked: well past the 1 s reconnect timer it is still taken and the second page still owns the window
  await page.waitForTimeout(2500);
  await expect(overlay(page)).toHaveAttribute('data-state', 'taken');
  await expect(overlay(second)).toHaveCount(0);

  // and back
  await workHere(page).click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(bubble(page, text)).toBeVisible();
  await expect(overlay(second)).toHaveAttribute('data-state', 'taken');
  await second.close();
});

test('reloading the owner twice never flashes the overlay @chat', async ({ page }) => {
  // record any moment the overlay is in the DOM, from the very first frame of each load
  await page.addInitScript(() => {
    (window as unknown as { __sawOverlay: boolean }).__sawOverlay = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="onetab"]')) (window as unknown as { __sawOverlay: boolean }).__sawOverlay = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await open(page);
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(composer(page)).toBeVisible();
    // past the 700 ms grace: if the server had taken the reload for a second tab, the overlay would have come by now
    await page.waitForTimeout(1200);
    await expect(overlay(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __sawOverlay: boolean }).__sawOverlay)).toBe(false);
    await expect(composer(page)).toBeEnabled();
  }
});
