import { expect, test, type Page } from '@playwright/test';

// M3-13: comments on an open file, in a real browser (hidden panes and rects cannot be checked in jsdom).
const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);
const panel = (page: Page) => page.locator('#comments');
const cards = (page: Page) => panel(page).locator('[data-comment-id]');
const filePane = (page: Page) => page.locator('[data-pane="file:notes.md"]');
const fileRoot = (page: Page) => page.locator('[data-file-path="notes.md"]');
const fileTab = (page: Page) => page.locator('[data-tab="file:notes.md"]');

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Box of "bravo" (chars 6..11 of the file's first paragraph). */
const bravoBox = (page: Page): Promise<Box> =>
  fileRoot(page).locator('p').first().evaluate((el) => {
    const r = document.createRange();
    r.setStart(el.firstChild!, 6);
    r.setEnd(el.firstChild!, 11);
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });

async function openPanel(page: Page) {
  if ((await panel(page).getAttribute('data-open')) !== 'true') await page.locator('#toggleComments').click();
  await expect(panel(page)).toHaveAttribute('data-open', 'true');
}

test('comment on an md file: mark in its pane only, badges, jump from a closed tab, batch names the path @chat', async ({ page }) => {
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => frames.push(String(f.payload))));
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await openPanel(page);
  while ((await cards(page).count()) > 0) {
    const n = await cards(page).count();
    await cards(page).first().getByRole('button', { name: /^(Delete|Удалить)$/ }).click();
    await expect(cards(page)).toHaveCount(n - 1);
  }

  await page.locator('#toggleTree').click();
  await page.locator('button[data-path="notes.md"]').click();
  await expect(fileRoot(page).locator('p').first()).toHaveText('alpha bravo charlie delta');
  await page.locator('#toggleTree').click();

  await fileRoot(page).locator('p').first().evaluate((el) => {
    const r = document.createRange();
    r.setStart(el.firstChild!, 6);
    r.setEnd(el.firstChild!, 11);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: /^💬/ }).click();
  await page.getByPlaceholder('Comment…').fill('rename bravo');
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();

  const mark = filePane(page).locator('[data-hl="pending"]');
  await expect(mark).toHaveCount(1);
  await expect.poll(async () => { const b = await mark.boundingBox(); return !!b && overlaps(b, await bravoBox(page)); }).toBe(true);
  await expect(page.locator('[data-pane="chat"] [data-hl]')).toHaveCount(0);
  await expect(fileTab(page).locator('[data-badge]')).toHaveText('1');
  await expect(cards(page).first()).toContainText('notes.md');

  // the hidden file pane paints nothing; back on it, the mark is where the text is
  await page.getByRole('tab', { name: /Chat|Чат/ }).click();
  await expect(filePane(page).locator('[data-hl]')).toHaveCount(0);
  await fileTab(page).click();
  await expect(mark).toHaveCount(1);
  await expect.poll(async () => { const b = await mark.boundingBox(); return !!b && overlaps(b, await bravoBox(page)); }).toBe(true);

  // closed tab: not orphaned; the quote reopens it and the mark is back
  await fileTab(page).getByRole('button', { name: /^(Close|Закрыть)$/ }).click();
  await expect(fileTab(page)).toHaveCount(0);
  await expect(cards(page).first()).not.toContainText(/fragment changed|фрагмент изменился/);
  await cards(page).first().getByText('bravo', { exact: true }).click();
  await expect(fileTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(mark).toHaveCount(1);
  await expect(cards(page).first()).not.toContainText(/fragment changed|фрагмент изменился/);

  await page.locator('#cSend').click();
  await expect.poll(() => frames.some((f) => f.includes('[notes.md]') && f.includes('rename bravo'))).toBe(true);
  await expect(page.getByText(/agent is working|агент работает/)).toBeHidden();
});
