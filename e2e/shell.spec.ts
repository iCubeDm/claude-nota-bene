import { expect, test, type Page } from '@playwright/test';

// `! cmd` in the composer (protocol 11): the server runs it, the feed shows the block. On the chat fixture's shared server,
// so every test looks for its own command text.

const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);
let seq = 0;
const uniq = (label: string) => `${label}-${Date.now().toString(36)}-${process.pid}-${seq++}`;
const blockOf = (page: Page, cmd: string) => page.locator('[data-testid="shell-block"]').filter({ hasText: cmd });

async function open(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
}

test('a ! command runs on the server and its block shows the output and the exit code @chat', async ({ page }) => {
  await open(page);
  const tag = uniq('hello');
  await composer(page).fill(`! echo ${tag}; echo oops >&2; exit 3`);
  await expect(page.getByTestId('shell-cue')).toBeVisible();
  await composer(page).press('Enter');
  const block = blockOf(page, tag);
  await expect(block.getByTestId('shell-output')).toContainText(`${tag}\noops`);
  await expect(block.getByTestId('shell-how')).toHaveText(/exit 3|код 3/);
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByTestId('shell-cue')).toHaveCount(0);
  // a command is no message: no user bubble carries it
  await expect(page.locator('[data-kind="user"]').filter({ hasText: tag })).toHaveCount(0);
});

test('Stop ends a long command, and the block says it was stopped @chat', async ({ page }) => {
  await open(page);
  const tag = uniq('slow');
  await composer(page).fill(`!echo ${tag}; sleep 60`);
  await composer(page).press('Enter');
  const block = blockOf(page, tag);
  await expect(block.getByTestId('shell-output')).toContainText(tag);
  // a second command while this one runs is refused, the draft kept
  await composer(page).fill('! echo second');
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('! echo second');
  await block.getByRole('button', { name: /Stop|Остановить/ }).click();
  await expect(block.getByTestId('shell-how')).toHaveText(/stopped|остановлена/);
  await expect(block).not.toHaveAttribute('data-running', /.*/);
  // free again
  await composer(page).press('Enter');
  await expect(blockOf(page, 'echo second').getByTestId('shell-output')).toContainText('second');
});

test('a reload brings the block back @chat', async ({ page }) => {
  await open(page);
  const tag = uniq('again');
  await composer(page).fill(`! echo ${tag}`);
  await composer(page).press('Enter');
  await expect(blockOf(page, tag).getByTestId('shell-output')).toContainText(tag);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(blockOf(page, tag).getByTestId('shell-output')).toContainText(tag);
  await expect(blockOf(page, tag).getByTestId('shell-how')).toHaveText(/exit 0|код 0/);
});
