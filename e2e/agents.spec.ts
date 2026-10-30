import { expect, test, type Page } from '@playwright/test';

// M2 step 1: a subagent's conversation in its own tab, against server/test/fixtures/controls.json ([agents] turn: one
// finished and one running subagent). Tagged @controls: the fixtures are tied to the five ports the e2e may use.
const composer = (page: Page) => page.locator('#composer-input');
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const bubble = (page: Page, text: string) => page.locator('[data-kind="user"]').filter({ hasText: text });
const donesAfter = (page: Page, text: string) => bubble(page, text).locator('xpath=following-sibling::*[@data-kind="done"]');
const card = (page: Page, description: string) => page.locator('[data-kind="agent-card"]').filter({ hasText: description }).last();
const pane = (page: Page, tool: string) => page.locator(`[data-pane="agent:${tool}"]`);

type Frame = Record<string, unknown>;
function track(page: Page): { sent: Frame[] } {
  const t = { sent: [] as Frame[] };
  page.on('websocket', (ws) => ws.on('framesent', (f) => { try { t.sent.push(JSON.parse(String(f.payload)) as Frame); } catch { /* not JSON */ } }));
  return t;
}

/** Runs the [agents] turn and waits for its cards. */
async function launch(page: Page): Promise<void> {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  const text = `[agents] ${uniq('launch')}`;
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(donesAfter(page, text).first()).toBeVisible();
  await expect(card(page, 'Review batch fixes')).toBeVisible();
}

test('the Agent call is a card; open shows the subagent\'s conversation read-only @controls', async ({ page }) => {
  await launch(page);
  await expect(card(page, 'Review batch fixes')).toContainText('general-purpose');
  await expect(card(page, 'Review batch fixes')).toHaveAttribute('data-status', 'done');
  await card(page, 'Review batch fixes').getByRole('button', { name: 'open' }).click();
  const p = pane(page, 'toolu_e2e_done');
  await expect(p).toBeVisible();
  await expect(p).toContainText('The send path looks correct and the tests cover it.');
  await expect(p).toContainText('Reading the changed files first.');
  await expect(p.getByRole('button', { name: /Bash · git diff --stat/ })).toBeVisible();
  await expect(page.locator('[role="tab"]').filter({ hasText: 'Review batch fixes' })).toBeVisible();
  // read-only: nothing to type into in the pane
  await expect(p.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0);
});

test('a running subagent shows its status and the tab survives a reload @controls', async ({ page }) => {
  await launch(page);
  await card(page, 'Look around the repo').getByRole('button', { name: 'open' }).click();
  const p = pane(page, 'toolu_e2e_run');
  await expect(p).toContainText('Still exploring the repository layout.');
  await expect(p.locator('[data-agent-running]')).toBeVisible();
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('[role="tab"]').filter({ hasText: 'Look around the repo' })).toBeVisible();
  await page.locator('[role="tab"]').filter({ hasText: 'Look around the repo' }).click();
  await expect(pane(page, 'toolu_e2e_run')).toContainText('Still exploring the repository layout.');
});

test('comment on a subagent reply, send: the message names the subagent and quotes the fragment @controls', async ({ page }) => {
  const t = track(page);
  await launch(page);
  await card(page, 'Review batch fixes').getByRole('button', { name: 'open' }).click();
  const reply = pane(page, 'toolu_e2e_done').locator('[data-kind="assistant"]').filter({ hasText: 'The send path looks correct' });
  await expect(reply).toBeVisible();
  await reply.locator('p').first().evaluate((el) => {
    const node = el.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 4);
    range.setEnd(node, 13); // "send path"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: /^💬/ }).click();
  const note = uniq('check the retry');
  await page.getByPlaceholder('Comment…').fill(note);
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();
  await expect(page.locator('#comments [data-comment-id]').filter({ hasText: note })).toHaveCount(1);
  // the mark is drawn in the subagent's pane
  await expect(pane(page, 'toolu_e2e_done').locator('[data-hl="pending"]').first()).toBeVisible();

  await page.locator('#cSend').click();
  await expect(bubble(page, note)).toHaveCount(1); // the batch is a message in the main chat
  const sent = t.sent.filter((f) => f.type === 'send' && String(f.text).includes(note)).at(-1)!;
  const body = String(sent.text);
  expect(body).toContain('[subagent reply «Review batch fixes»]');
  expect(body).toContain('send path');
  const comments = t.sent.filter((f) => f.type === 'comments').at(-1);
  expect(JSON.stringify(comments)).toContain('"agent":"toolu_e2e_done"');
});

test('a resumed agent (a second task start with the SendMessage call) opens the same tab from the drawer and from its card @controls', async ({ page }) => {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  const text = `[resume] ${uniq('resume')}`;
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(donesAfter(page, text).first()).toBeVisible();
  await expect(card(page, 'Resumed reviewer')).toBeVisible();
  await page.keyboard.press('Alt+t');
  const row = page.locator('[data-task="e2e-resumed"]');
  await expect(row).toHaveAttribute('data-status', 'running'); // the resume restarted it
  await row.locator('[data-task-open]').click();
  const p = pane(page, 'toolu_e2e_resumed'); // the original Agent call, not the SendMessage one
  await expect(p).toContainText('The resumed agent answers from its own transcript.');
  await expect(page.locator('[data-pane^="agent:"]')).toHaveCount(1);
  await page.locator('[role="tab"]').first().click();
  await card(page, 'Resumed reviewer').getByRole('button', { name: 'open' }).click();
  await expect(page.locator('[role="tab"]').filter({ hasText: 'Resumed reviewer' })).toHaveCount(1); // the same tab
  await expect(p).toContainText('The resumed agent answers from its own transcript.');
});
