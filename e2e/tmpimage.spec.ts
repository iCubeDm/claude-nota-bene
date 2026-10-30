import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { apiGet } from './auth.ts';

// B1e: an image the agent left in a temp folder opens from the chat. The bytes come from /tmpimage, which the cookie alone
// does not open (key tier), into a blob; /file stays inside the project.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);

test('a temp image path in a message opens as a tab with the picture; the cookie alone cannot fetch it; a vanished file shows the short state @files', async ({ page, context }) => {
  const dir = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), 'nb-e2e-img-'));
  const file = nodePath.join(dir, 'shot.png');
  fs.writeFileSync(file, PNG);
  try {
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    await composer(page).fill(`look at \`${file}\` please`);
    await composer(page).press('Enter');
    const ref = page.locator(`[data-kind="user"] code.ref[data-path="${file}"]`).last();
    await expect(ref).toBeVisible();
    await ref.click();
    await expect(page.locator(`[data-tab="file:${file}"]`)).toHaveAttribute('aria-selected', 'true');
    const img = page.locator(`[data-pane="file:${file}"] img`);
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);

    // the cookie alone is refused; with the key the route answers, and a path outside the temp folders does not
    const q = `/tmpimage?path=${encodeURIComponent(file)}`;
    expect((await context.request.get(q)).status()).toBe(401);
    expect((await apiGet(page, q)).status()).toBe(200);
    expect((await apiGet(page, `/tmpimage?path=${encodeURIComponent(nodePath.join(os.homedir(), '.zshrc'))}`)).status()).toBe(404);
    expect((await context.request.get(`/file?path=${encodeURIComponent(file)}`)).status()).not.toBe(200); // /file did not widen

    // the file goes away: reload shows the short state, the tab stays
    fs.unlinkSync(file);
    await page.locator(`[data-pane="file:${file}"]`).locator('xpath=ancestor::*[@data-file-view]').getByRole('button', { name: /^(Reload|Перезагрузить)$/ }).click();
    await expect(page.getByText(/This file no longer exists|Этого файла больше нет/)).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-tab="file:${file}"]`)).toBeVisible();
    await page.locator(`[data-tab="file:${file}"]`).click();
    await expect(page.getByText(/This file no longer exists|Этого файла больше нет/)).toBeVisible();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
