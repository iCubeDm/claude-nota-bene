import { expect, test, type Locator, type Page } from '@playwright/test';

const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const bubble = (page: Page, text: string) => page.locator('[data-kind="user"]').filter({ hasText: text });
const reply = (page: Page, text: string) =>
  bubble(page, text).locator('xpath=following-sibling::*[@data-kind="assistant"]').first();
const donesAfter = (page: Page, text: string) =>
  bubble(page, text).locator('xpath=following-sibling::*[@data-kind="done"]');
const panel = (page: Page) => page.locator('#comments');
const cards = (page: Page) => panel(page).locator('[data-comment-id]');
const popup = (page: Page) => page.getByRole('dialog').filter({ has: page.getByPlaceholder('Comment…') });
const commentBox = (page: Page) => page.getByPlaceholder('Comment…');

async function open(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
}

/** The turn is fully in the feed (also after a reload replay): its done line is there and the reply is final. */
async function settled(page: Page, text: string) {
  await expect(donesAfter(page, text).first()).toBeVisible();
  await expect(reply(page, text)).toHaveAttribute('data-final', 'true');
  await expect(page.getByText(/agent is working|агент работает/)).toBeHidden();
}

/** Sends a message and waits for its final reply to settle. */
async function turn(page: Page, label: string): Promise<string> {
  const text = uniq(label);
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await settled(page, text);
  return text;
}

/** Selects the first paragraph of the reply under the bubble with `text` and fires the mouseup the app listens to. */
async function select(page: Page, text: string, from = 0, to?: number) {
  const p = reply(page, text).locator('p').first();
  await p.evaluate(
    (el, [a, b]) => {
      const node = el.firstChild as Text;
      const range = document.createRange();
      range.setStart(node, a as number);
      range.setEnd(node, (b as number | null) ?? node.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    },
    [from, to ?? null],
  );
}

async function openPopup(page: Page, text: string) {
  await select(page, text, 0, 4);
  await page.getByRole('button', { name: /^💬/ }).click();
  await expect(popup(page)).toBeVisible();
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** Box of the characters [0,4) of the first paragraph of the reply: where the selection / mark must be. */
const anchoredBox = (page: Page, text: string): Promise<Box> =>
  reply(page, text).locator('p').first().evaluate((el) => {
    const node = el.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 4);
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });

const marks = (page: Page, kind: 'pending' | 'sent'): Locator => page.locator(`[data-hl="${kind}"]`);

/** The open state is remembered in localStorage (shared by pages of one context), so never blindly toggle. */
async function openPanel(page: Page) {
  await expect(page.locator('#toggleComments')).toBeVisible();
  if ((await panel(page).getAttribute('data-open')) !== 'true') await page.locator('#toggleComments').click();
  await expect(panel(page)).toHaveAttribute('data-open', 'true');
}

/** Pending comments live per session on the shared server: every test removes what it adds. */
async function clearPending(page: Page) {
  await openPanel(page);
  while ((await cards(page).count()) > 0) {
    const n = await cards(page).count();
    await cards(page).first().getByRole('button', { name: /^(Delete|Удалить)$/ }).click();
    await expect(cards(page)).toHaveCount(n - 1);
  }
}

test('select, comment, card, send @chat', async ({ page }) => {
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'comment flow');
  const note = uniq('please expand');
  await openPopup(page, text);
  await commentBox(page).fill(note);
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();

  await expect(popup(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText(note);
  await expect(marks(page, 'pending').first()).toBeVisible();
  const sentBefore = await marks(page, 'sent').count();

  await page.locator('#cSend').click();
  const sent = bubble(page, note);
  await expect(sent).toHaveCount(1);
  await sent.locator('summary').click();
  await expect(sent).toContainText(note);
  await expect(marks(page, 'sent')).toHaveCount(sentBefore + 1);
  await expect(marks(page, 'pending')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(0);
  // the agent answers the batch
  await expect(sent.locator('xpath=following-sibling::*[@data-kind="assistant"]').first()).toHaveAttribute('data-final', 'true');
  await expect(page.getByText(/agent is working|агент работает/)).toBeHidden();

  // sent comments are server state: a reload brings back the mark and the bubble's summary
  const sentAfter = await marks(page, 'sent').count();
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await settled(page, text);
  await expect(marks(page, 'sent')).toHaveCount(sentAfter);
  await expect(marks(page, 'pending')).toHaveCount(0);
  const again = bubble(page, note);
  await expect(again).toHaveCount(1);
  await again.locator('summary').click();
  await expect(again).toContainText(note);
});

test('a quick label adds a comment in one click @chat', async ({ page }) => {
  const frames: string[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => frames.push(String(f.payload))));
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'label flow');
  await openPopup(page, text);
  await popup(page).getByRole('button', { name: /Verify this|Проверь/ }).click();

  await expect(popup(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first().getByLabel(/Verify this|Проверь/)).toBeVisible();
  await page.locator('#cSend').click();
  await expect.poll(() => frames.some((f) => f.includes('Verify by reading the actual code'))).toBe(true);
  await expect(page.getByText(/agent is working|агент работает/)).toBeHidden();
});

test('shortcode picker inserts an emoji; Esc closes only the picker @chat', async ({ page }) => {
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'emoji flow');
  await openPopup(page, text);
  const box = commentBox(page);
  await box.fill('');
  await box.pressSequentially(':+1');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('👍');
  await expect(list).toBeHidden();

  await box.pressSequentially(' :smi');
  await expect(list).toBeVisible();
  await box.press('Escape');
  await expect(list).toBeHidden();
  await expect(popup(page)).toBeVisible();
  await expect(box).toHaveValue('👍 :smi');
  await box.press('Escape');
  await expect(popup(page)).toBeHidden();
  await expect(cards(page)).toHaveCount(0);
});

test('edit and delete from the card; a click on the mark opens it @chat', async ({ page }) => {
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'edit flow');
  await openPopup(page, text);
  await commentBox(page).fill('first draft');
  await commentBox(page).press('Control+Enter');
  await expect(cards(page)).toHaveCount(1);

  // edit in the panel
  const card = cards(page).first();
  await card.getByRole('button', { name: /^(Edit|Править|Изменить)/ }).click();
  await page.keyboard.type(' v2');
  await card.getByRole('button', { name: /^(Save|Сохранить)$/ }).click();
  await expect(card).toContainText('first draft v2');

  // close the panel, click the mark: the popover card opens
  await page.locator('#cClose').click();
  await expect(panel(page)).toHaveAttribute('data-open', 'false');
  const mark = marks(page, 'pending').first();
  await expect(mark).toBeVisible();
  const box = (await mark.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // real hit path: the layer ignores pointer events
  const pop = page.getByRole('dialog').filter({ hasText: 'first draft v2' });
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // delete from the panel
  await openPanel(page);
  await cards(page).first().getByRole('button', { name: /^(Delete|Удалить)$/ }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(marks(page, 'pending')).toHaveCount(0);
});

test('reload keeps the pending comment and its mark @chat', async ({ page }) => {
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'reload flow');
  await openPopup(page, text);
  await commentBox(page).fill('survives reload');
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();
  await expect(cards(page)).toHaveCount(1);

  await page.reload();
  await expect(composer(page)).toBeVisible();
  await openPanel(page);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText('survives reload');
  const mark = marks(page, 'pending').first();
  await expect(mark).toBeVisible();
  await settled(page, text);
  expect(overlaps((await mark.boundingBox())!, await anchoredBox(page, text))).toBe(true);
  await clearPending(page);
});

test('two windows see the same comment @chat', async ({ page, browser }, testInfo) => {
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'two windows');
  // a separate context: own localStorage, so the sync can only travel through the server
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, locale: 'en-US' });
  const other = await ctx.newPage();
  await open(other);
  await settled(other, text);

  await openPopup(page, text);
  await commentBox(page).fill('from window A');
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();

  await openPanel(other);
  await expect(cards(other)).toHaveCount(1);
  await expect(cards(other).first()).toContainText('from window A');
  await expect(marks(other, 'pending').first()).toBeVisible();

  // and deletion travels back
  await cards(other).first().getByRole('button', { name: /^(Delete|Удалить)$/ }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(marks(page, 'pending')).toHaveCount(0);
  await ctx.close();
});

test('selecting right after a reload shows the button and keeps it @chat', async ({ page }) => {
  await open(page);
  await clearPending(page);
  const text = await turn(page, 'select after reload');
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await settled(page, text);
  await select(page, text, 0, 4);
  const btn = page.getByRole('button', { name: /^💬/ });
  await expect(btn).toBeVisible();
  // late layout / autoscroll after the replay must not hide it
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('selection survives a streaming turn @slow', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await clearPending(page);
  let earlier = '';
  for (let i = 0; i < 6; i++) earlier = await turn(page, `fill ${i}`);
  const next = uniq('streaming');
  await composer(page).fill(next);
  await composer(page).press('Enter');
  const working = page.getByText(/agent is working|агент работает/);
  await expect(working).toBeVisible();
  await select(page, earlier, 0, 4);
  const btn = page.getByRole('button', { name: /^💬/ });
  await expect(btn).toBeVisible();
  await expect(working).toBeVisible(); // proof: the selection was made mid-stream
  // the feed autoscrolls on every delta; the button must follow the text, not vanish
  await expect(working).toBeHidden({ timeout: 20_000 });
  await expect(btn).toBeVisible();
  const text = (await anchoredBox(page, earlier));
  const b = (await btn.boundingBox())!;
  expect(Math.abs(b.y - (text.y + text.height))).toBeLessThan(40); // sits right under the selected text
  await btn.click();
  await commentBox(page).fill('while streaming');
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();
  await expect(cards(page)).toHaveCount(1);
  await clearPending(page);
});

test('Esc while the agent works: picker, then popup, then the turn @slow', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  await clearPending(page);
  const earlier = await turn(page, 'esc base');
  const next = uniq('esc busy');
  await composer(page).fill(next);
  await composer(page).press('Enter');
  const working = page.getByText(/agent is working|агент работает/);
  await expect(working).toBeVisible();

  await openPopup(page, earlier);
  const box = commentBox(page);
  await box.pressSequentially(':smi');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();

  await box.press('Escape'); // 1: the picker only
  await expect(list).toBeHidden();
  await expect(popup(page)).toBeVisible();
  await expect(working).toBeVisible();

  await box.press('Escape'); // 2: the popup only
  await expect(popup(page)).toBeHidden();
  await expect(working).toBeVisible();
  await expect(donesAfter(page, next)).toHaveCount(0);

  await page.keyboard.press('Escape'); // 3: now it interrupts the turn
  await expect(donesAfter(page, next).first()).toHaveText(/прервано|interrupted/);
  await expect(working).toBeHidden();
});
