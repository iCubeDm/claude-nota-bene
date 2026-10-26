import { expect, test, type Page } from '@playwright/test';
import { en } from '../web/src/i18n/en.ts';
import { ru } from '../web/src/i18n/ru.ts';

const DONE = /готово|done/;
const INTERRUPTED = /прервано|interrupted/;

const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);
const doneLines = (page: Page) => page.locator('[data-kind="done"]');
const WORKING = /agent is working|агент работает/;
// unique per call, so a test finds its own turn whatever history the shared server already holds
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const bubble = (page: Page, text: string) => page.locator('[data-kind="user"]').filter({ hasText: text });
// done lines that follow the bubble with this text (feed items are siblings), independent of replay timing
const donesAfter = (page: Page, text: string) =>
  bubble(page, text).locator('xpath=following-sibling::*[@data-kind="done"]');
const userBubbles = (page: Page) => page.locator('[data-kind="user"]');

async function open(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
}

async function send(page: Page, text: string, key = 'Enter') {
  await composer(page).fill(text);
  await composer(page).press(key);
}

test('streams a markdown reply and shows the done line @chat', async ({ page }) => {
  await open(page);
  const text = uniq('show me');
  await send(page, text);
  // the newest reply is the last one in the feed (earlier tests may have left replies in the shared server)
  await expect(donesAfter(page, text).first()).toHaveText(DONE);
  await expect(page.getByRole('heading', { name: 'Hello' }).last()).toBeVisible();
  await expect(page.locator('pre code').last()).toContainText('const x = 1;');
  await expect(page.locator('.mermaid-out svg').last()).toBeVisible();
});

test('mid-turn send is marked while working @slow', async ({ page }) => {
  await open(page);
  const a = uniq('first mid');
  const b = uniq('second mid');
  await send(page, a);
  await expect(page.getByText(WORKING)).toBeVisible();
  await send(page, b);
  await expect(bubble(page, b)).toContainText(/while working|во время работы/);
  await expect(bubble(page, a)).not.toContainText(/while working|во время работы/);
  // the second message runs as its own turn: the agent keeps working after the first done line
  await expect(donesAfter(page, a)).toHaveCount(1, { timeout: 20_000 });
  await expect(donesAfter(page, a).nth(0)).toHaveText(DONE);
  await expect(page.getByText(WORKING)).toBeVisible();
  // both turns end, each with a normal done line after the first bubble
  await expect(donesAfter(page, a)).toHaveCount(2, { timeout: 20_000 });
  await expect(donesAfter(page, a).nth(1)).toHaveText(DONE);
  await expect(page.getByText(WORKING)).toBeHidden();
});

test('force send interrupts @slow', async ({ page }) => {
  await open(page);
  const a = uniq('first force');
  const b = uniq('second force');
  await send(page, a);
  await expect(page.getByText(WORKING)).toBeVisible();
  await send(page, b, 'Control+Enter');
  await expect(bubble(page, b)).toContainText(/interrupted the agent|прервал/);
  await expect(donesAfter(page, a).nth(0)).toHaveText(INTERRUPTED);
  // the forced message's own turn completes normally
  await expect(donesAfter(page, a).nth(1)).toHaveText(DONE, { timeout: 20_000 });
  await expect(page.getByText(WORKING)).toBeHidden();
});

test('Esc and Stop interrupt @slow', async ({ page }) => {
  await open(page);
  const stop = page.getByRole('button', { name: /^(Stop the agent|Остановить агента)/ });
  const a = uniq('to be escaped');
  const b = uniq('to be stopped');

  await send(page, a);
  await expect(stop).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(donesAfter(page, a).first()).toHaveText(INTERRUPTED);
  await expect(stop).toBeDisabled();

  await send(page, b);
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(donesAfter(page, b).first()).toHaveText(INTERRUPTED);
  await expect(stop).toBeDisabled();
});

test('permission allow @ask', async ({ page }) => {
  await open(page);
  const text = uniq('run it');
  await send(page, text);
  const card = bubble(page, text).locator('xpath=following-sibling::*[@data-kind="permission"]');
  await expect(card).toContainText('ls -la');
  await card.getByRole('button', { name: /Allow|Разрешить/ }).click();
  await expect(card).toContainText(/✓ allowed|✓ разрешено/);
  await expect(donesAfter(page, text).first()).toHaveText(DONE);
});

test('reload replays the conversation @chat', async ({ page }) => {
  await open(page);
  const text = uniq('replay me');
  await send(page, text);
  // settled: our bubble is there, the agent is idle and the feed ends with a done line
  // (a bare "last done line" could still be one replayed from an earlier test)
  await expect(userBubbles(page).filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByText(WORKING)).toBeHidden();
  await expect(page.locator('[data-kind="user"], [data-kind="done"]').last()).toHaveAttribute('data-kind', 'done');
  const users = await userBubbles(page).count();
  const dones = await doneLines(page).count();
  await page.reload();
  await expect(userBubbles(page).filter({ hasText: text })).toHaveCount(1);
  await expect(userBubbles(page)).toHaveCount(users);
  await expect(doneLines(page)).toHaveCount(dones);
  await expect(page.getByRole('heading', { name: 'Hello' }).last()).toBeVisible();
});

// M6-05: real key events (the picker listens at window capture and writes through the native value setter)
test('typing ":smi" in the composer opens the emoji list; Enter inserts 😄 and sends nothing @chat', async ({ page }) => {
  await open(page);
  const before = await userBubbles(page).count();
  await composer(page).click();
  await page.keyboard.type(':smi');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(composer(page)).toHaveValue('😄');
  await page.keyboard.type(' :smile');
  await expect(page.getByRole('option').first()).toContainText(':smile');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  expect(await userBubbles(page).count()).toBe(before);
  await composer(page).fill('');
});

// M6-06: the user's message is markdown (and a single newline stays a line break)
test('a user message renders markdown @chat', async ({ page }) => {
  await open(page);
  const tag = uniq('md');
  await send(page, `**${tag}**\nsecond \`code\``);
  const b = bubble(page, tag);
  await expect(b.locator('strong')).toHaveText(tag);
  await expect(b.locator('br')).toHaveCount(1);
  await expect(b.locator('code')).toHaveText('code');
  await expect(donesAfter(page, tag).first()).toBeVisible();
});

test('language toggle switches the placeholder @chat', async ({ page }) => {
  await open(page);
  await expect(page.getByPlaceholder(en.composerPh)).toBeVisible();
  await page.locator('#langBtn').click();
  await expect(page.getByPlaceholder(ru.composerPh)).toBeVisible();
  await page.locator('#langBtn').click();
  await expect(page.getByPlaceholder(en.composerPh)).toBeVisible();
});

test('tool line expands to the command and the output, also after a reload (hub replay) @chat', async ({ page }) => {
  await open(page);
  const text = uniq('run a tool');
  await send(page, text);
  await expect(donesAfter(page, text).first()).toHaveText(DONE);
  const expand = async () => {
    const line = page.getByRole('button', { name: /Bash · echo tool-cmd-marker/ }).last();
    await line.click();
    await expect(line).toHaveAttribute('aria-expanded', 'true');
    const panel = page.getByTestId('tool-panel').last();
    await expect(panel).toContainText('echo tool-cmd-marker');
    await expect(panel).toContainText('tool-out-marker');
    await expect(panel).toContainText('second line');
  };
  await expand();
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expand();
});
