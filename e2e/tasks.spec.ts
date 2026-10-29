import { expect, test, type Page } from '@playwright/test';

// M2 step 2: the task indicator, the drawer, a shell task's output tab, Stop. Against server/test/fixtures/controls.json
// (the [tasks-drawer] turn: a running shell, a finished one, a running background agent with a shell child; the fake
// reveals one more chunk of a shell's output per read). Tagged @controls: the fixtures are tied to the five e2e ports.
const composer = (page: Page) => page.locator('#composer-input');
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const row = (page: Page, id: string) => page.locator(`[data-task="${id}"]`);
const indicator = (page: Page) => page.locator('#tasks-indicator');

type Frame = Record<string, unknown>;
function track(page: Page): { sent: Frame[] } {
  const t = { sent: [] as Frame[] };
  page.on('websocket', (ws) => ws.on('framesent', (f) => { try { t.sent.push(JSON.parse(String(f.payload)) as Frame); } catch { /* not JSON */ } }));
  return t;
}

async function launch(page: Page): Promise<void> {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(`[tasks-drawer] ${uniq('go')}`);
  await composer(page).press('Enter');
  await expect(indicator(page)).toContainText('3 tasks');
}

async function stop(page: Page, id: string): Promise<void> {
  const btn = row(page, id).locator('[data-task-stop]');
  await btn.click();
  await expect(btn).toContainText('Stop?');
  await btn.click();
  await expect(row(page, id)).toHaveAttribute('data-status', 'stopped');
}

test('the indicator counts the running tasks; the drawer lists them all with their state @controls', async ({ page }) => {
  await launch(page);
  await expect(indicator(page)).toHaveAttribute('data-running', 'true');
  await indicator(page).click();
  const drawer = page.locator('[data-tasks-drawer]');
  await expect(drawer).toBeVisible();
  await expect(row(page, 'e2e-sh-run')).toHaveAttribute('data-status', 'running');
  await expect(row(page, 'e2e-sh-done')).toHaveAttribute('data-status', 'done');
  await expect(row(page, 'e2e-ag-bg')).toContainText('12k tok');
  await expect(row(page, 'e2e-ag-bg')).toContainText('Read');
  await expect(row(page, 'e2e-ag-bg')).toContainText('reading docs/architecture.md');
  // the shell the agent launched is nested under it
  const nested = await row(page, 'e2e-sh-child').evaluate((n) => parseInt((n as HTMLElement).style.paddingLeft, 10));
  const parent = await row(page, 'e2e-ag-bg').evaluate((n) => parseInt((n as HTMLElement).style.paddingLeft, 10));
  expect(nested).toBeGreaterThan(parent);
  // it overlays: the chat pane keeps its size
  const before = await page.locator('[data-pane="chat"]').boundingBox();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  expect((await page.locator('[data-pane="chat"]').boundingBox())?.height).toBe(before?.height);
  await page.keyboard.press('Alt+t');
  await expect(drawer).toBeVisible();
  await page.mouse.click(300, 200);
  await expect(drawer).toBeHidden();
});

test('a shell task\'s output grows in its own tab; Stop ends it as stopped @controls', async ({ page }) => {
  const t = track(page);
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await indicator(page).click();
  await row(page, 'e2e-sh-run').locator('[data-task-open]').click();
  const pane = page.locator('[data-pane="shell:e2e-sh-run"]');
  await expect(pane).toBeVisible();
  await expect(page.locator('[role="tab"]').filter({ hasText: 'tail -f build.log' })).toBeVisible();
  // one more chunk per read (1 s apart); the escape sequence is gone
  await expect(pane.locator('[data-shell-output]')).toContainText('compiling 1/4');
  await expect(pane.locator('[data-shell-output]')).toContainText('compiling 2/4');
  expect(await pane.locator('[data-shell-output]').textContent()).not.toContain('\u001b');
  const stopBtn = pane.locator('[data-task-stop]');
  await stopBtn.click();
  await expect(stopBtn).toContainText('Stop?');
  await stopBtn.click();
  await expect(pane.locator('[data-shell-status]')).toHaveText('stopped');
  await expect(stopBtn).toBeHidden();
  expect(t.sent).toContainEqual({ type: 'task-stop', id: 'e2e-sh-run' });
  // the output no longer grows
  const frozen = await pane.locator('[data-shell-output]').textContent();
  await page.waitForTimeout(2500);
  expect(await pane.locator('[data-shell-output]').textContent()).toBe(frozen);
  // the drawer says so too
  await page.keyboard.press('Alt+t');
  await expect(row(page, 'e2e-sh-run')).toHaveAttribute('data-status', 'stopped');
  // the tab is saved with the root's tabs
  await page.reload();
  await expect(page.locator('[role="tab"]').filter({ hasText: 'tail -f build.log' })).toBeVisible();
});

test('Stop in the drawer ends the background agent and its shell; the indicator goes quiet @controls', async ({ page }) => {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await indicator(page).click();
  await stop(page, 'e2e-ag-bg');
  await stop(page, 'e2e-sh-child');
  await expect(indicator(page)).not.toHaveAttribute('data-running', 'true');
  await expect(indicator(page)).toContainText('✓');
});
