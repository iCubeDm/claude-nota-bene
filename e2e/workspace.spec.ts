import { expect, test, type Page } from '@playwright/test';

// M6-16: the workspace frame of Package B and C in a real browser — strips, tab overflow, Alt+E, the hotkeys and
// the Settings tab. The `files` fixture (its project has docs/, src/, media/ and big.log).
const composer = (page: Page) => page.getByPlaceholder(/Message the agent|Сообщение агенту/);
const sheet = (page: Page) => page.locator('#tree-sheet');
const comments = (page: Page) => page.locator('#comments');
const strip = (page: Page) => page.getByRole('tablist');
const activeTab = (page: Page) => strip(page).locator('[aria-selected="true"]');

async function start(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  // a clean frame: both panels open (the default), only the chat tab
  if (await sheet(page).isHidden()) await page.locator('#toggleTree').click();
  if (await comments(page).isHidden()) await page.locator('#toggleComments').click();
  await page.keyboard.press('Escape');
  for (;;) {
    const n = await strip(page).locator('[data-tab]').count();
    if (n <= 1) break;
    await strip(page).locator('[data-tab]').nth(1).getByRole('button', { name: /^(Close|Закрыть)$/ }).click();
  }
}
/** Expands the whole tree and opens the given files, in order. */
async function open(page: Page, paths: string[]) {
  await page.getByRole('button', { name: /^(Expand all|Развернуть всё)$/ }).click();
  for (const p of paths) {
    await sheet(page).locator(`button[data-path="${p}"]`).click();
    await expect(activeTab(page)).toHaveAttribute('data-tab', `file:${p}`);
  }
}
/** Focus on empty space (the active pane), so plain keys and Option combos are ours. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test('the strips toggle their panels by click and by Ctrl/⌘+Shift+F / C, and the state survives a reload @files', async ({ page }) => {
  await start(page);
  await expect(sheet(page)).toBeVisible();
  await blur(page);
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(sheet(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Shift+KeyC');
  await expect(comments(page)).toBeHidden();
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(sheet(page)).toBeHidden();
  await expect(comments(page)).toBeHidden();
  await page.locator('#toggleTree').click();
  await page.locator('#toggleComments').click();
  await expect(sheet(page)).toBeVisible();
  await expect(comments(page)).toBeVisible();
});

test('tab overflow: no scrollbar, the active tab stays in view, ▾ lists the hidden ones and opens one by search @files', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 }); // the docked panels leave a narrow middle column
  await start(page);
  const files = ['big.log', 'src/a.ts', 'docs/pic.png', 'docs/big.png', 'docs/Отчёт #1 (final).md'];
  await open(page, files);
  const m = await strip(page).evaluate((el) => ({ over: el.scrollWidth > el.clientWidth, bar: (el as HTMLElement).offsetHeight - el.clientHeight }));
  expect(m.over).toBe(true);
  expect(m.bar).toBe(0);
  // the active (last) tab is fully inside the strip
  const inView = () => strip(page).evaluate((el) => {
    const a = el.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    return a.left >= s.left - 1 && a.right <= s.right + 1;
  });
  expect(await inView()).toBe(true);
  // the wheel scrolls the strip back
  await strip(page).hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => strip(page).evaluate((el) => el.scrollLeft)).toBe(0);
  // ▾: the hidden section names the tabs out of view; a search and Enter open one, and it is scrolled into view
  await page.getByRole('button', { name: /^(All tabs|Все вкладки)$/ }).click();
  const list = page.getByRole('listbox', { name: /^(All tabs|Все вкладки)$/ });
  await expect(list.getByText(/^(Hidden|Скрытые)$/)).toBeVisible();
  await page.getByRole('combobox', { name: /^(Find a tab…|Найти вкладку…)$/ }).fill('final');
  await expect(list.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(activeTab(page)).toHaveAttribute('data-tab', 'file:docs/Отчёт #1 (final).md');
  await expect.poll(inView).toBe(true); // it was active already: the pick itself scrolls it back into view
  // the focus went to that tab, not to <body>
  await expect(activeTab(page)).toBeFocused();
});

test('Alt+E: the recent files with the previous one selected; Enter flips back; a query searches the project @files', async ({ page }) => {
  await start(page);
  // a tab counts as visited once it stays active 300 ms
  await open(page, ['src/a.ts']);
  await page.waitForTimeout(400);
  await open(page, ['big.log']);
  await page.waitForTimeout(400);
  await page.keyboard.press('Alt+KeyE');
  const list = page.getByRole('listbox', { name: /^(Recent files|Недавние файлы)/ });
  await expect(list.getByRole('option').first()).toHaveAttribute('data-recent', 'big.log');
  await expect(list.getByRole('option', { selected: true })).toHaveAttribute('data-recent', 'src/a.ts');
  await page.keyboard.press('Enter');
  await expect(activeTab(page)).toHaveAttribute('data-tab', 'file:src/a.ts');
  await page.keyboard.press('Alt+KeyE');
  await page.keyboard.type('pic');
  await expect(list.locator('[data-recent="docs/pic.png"]')).toBeVisible(); // from /complete, never opened
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  // from the composer too, and nothing is typed there
  await composer(page).click();
  await page.keyboard.press('Alt+KeyE');
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(composer(page)).toHaveValue('');
});
