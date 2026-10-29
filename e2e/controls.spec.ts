import { expect, test, type Page } from '@playwright/test';
import type { Mode } from '@nota-bene/shared';
import { en } from '../web/src/i18n/en.ts';

// M4-16: session and agent controls against server/test/fixtures/controls.json. A turn is picked by a tag in the prompt
// ([plan], [hot], ...), so these tests do not depend on how many turns the shared server has already run. The tests
// that change the server's session (clear, switch) leave it on an idle session of the project root.
const composer = (page: Page) => page.locator('#composer-input'); // its placeholder changes with a suggestion
const pill = (page: Page) => page.getByRole('button', { name: en.modeTip });
const toasts = (page: Page) => page.getByTestId('toast');
let seq = 0;
const uniq = (label: string) => `${label} ${Date.now().toString(36)}-${process.pid}-${seq++}`;
const bubble = (page: Page, text: string) => page.locator('[data-kind="user"]').filter({ hasText: text });
const donesAfter = (page: Page, text: string) => bubble(page, text).locator('xpath=following-sibling::*[@data-kind="done"]');

type Frame = Record<string, unknown>;
/** Every WebSocket frame the page sends and receives, parsed. Attach before page.goto. */
function track(page: Page): { sent: Frame[]; got: Frame[] } {
  const t = { sent: [] as Frame[], got: [] as Frame[] };
  const keep = (into: Frame[]) => (f: { payload: string | Buffer }) => {
    try { into.push(JSON.parse(String(f.payload)) as Frame); } catch { /* not JSON: ignore */ }
  };
  page.on('websocket', (ws) => { ws.on('framesent', keep(t.sent)); ws.on('framereceived', keep(t.got)); });
  return t;
}

async function open(page: Page) {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await expect(pill(page)).toBeVisible(); // the mode is known once the server has said so
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** Sends and waits until the turn has its done line. */
async function turn(page: Page, tag: string, label = 'turn'): Promise<string> {
  const text = `${tag} ${uniq(label)}`;
  await send(page, text);
  await expect(donesAfter(page, text).first()).toBeVisible();
  await expect(page.getByText(en.working)).toBeHidden();
  return text;
}

/** Picks a mode in the pill's menu and waits for the server's echo, so the next test starts from a settled server. */
async function setMode(page: Page, t: ReturnType<typeof track>, mode: Mode) {
  const label = en[`mode_${mode}`];
  if (((await pill(page).textContent()) ?? '').trim() === label) return;
  const before = t.got.length;
  await pill(page).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
  await expect(pill(page)).toHaveText(label);
  await expect.poll(() => t.got.slice(before).some((f) => f.kind === 'mode' && f.mode === mode)).toBe(true);
}

const modeSends = (t: ReturnType<typeof track>, from = 0) => t.sent.slice(from).filter((f) => f.type === 'mode');

/**
 * Idempotent clean-up: every test leaves the shared server as the next one expects it, even when it failed half way.
 * Each step first checks whether there is anything to do, so a clean server costs one page load and no changes.
 */
test.afterEach(async ({ page }) => {
  const t = track(page);
  await open(page);
  // the Alpha session first (comments and permissions belong to the session)
  const root = page.locator('#root-path');
  await expect(page.locator('#conn')).toHaveText(''); // a switch still running finishes first
  if (/\/other$/.test((await root.textContent()) ?? '')) {
    await page.locator('#sessBtn').click();
    await page.locator('[data-sess-item]').filter({ hasText: 'Alpha session' }).click();
    await page.getByRole('dialog').getByRole('button', { name: en.switchBtn }).click();
    await expect(root).not.toHaveText(/\/other$/);
    await expect(page.locator('#conn')).toHaveText('');
  }
  // a turn still running (a failed test): stop it so the permission and the mode below can settle
  if (await page.getByText(en.working).isVisible()) {
    await page.getByRole('button', { name: en.stopTip }).click();
    await expect(page.getByText(en.working)).toBeHidden();
  }
  // an open permission ask: deny it
  const open_ = page.locator('[data-kind="permission"]').filter({ has: page.getByRole('button', { name: en.deny }) });
  while ((await open_.count()) > 0) {
    const before = await open_.count();
    await open_.first().getByRole('button', { name: en.deny }).click();
    await expect(open_).toHaveCount(before - 1);
  }
  // pending comments: delete them so no later test sends them as a batch
  const cards = page.locator('#comments [data-comment-id]');
  if ((await cards.count()) > 0) {
    if ((await page.locator('#comments').getAttribute('data-open')) !== 'true') await page.locator('#toggleComments').click();
    while ((await cards.count()) > 0) {
      const before = await cards.count();
      await cards.first().getByRole('button', { name: en.del }).click();
      await expect(cards).toHaveCount(before - 1);
    }
  }
  // the model back on the first one (and no effort)
  const modelPill = page.getByRole('button', { name: en.modelTip });
  await expect(modelPill).toBeEnabled();
  if ((await modelPill.textContent()) !== 'Sonnet 5') {
    await modelPill.click();
    await page.getByRole('menuitem', { name: /^Sonnet 5/ }).click();
    await expect(modelPill).toHaveText('Sonnet 5');
  }
  await setMode(page, t, 'default');
});

test('model pill: pick another model and an effort; a reload keeps them @controls', async ({ page }) => {
  await open(page);
  const modelPill = page.getByRole('button', { name: en.modelTip });
  await expect(modelPill).toBeEnabled(); // the list has arrived
  await modelPill.click();
  await page.getByRole('menuitem', { name: /^Opus 5/ }).click();
  await expect(modelPill).toHaveText('Opus 5');
  await modelPill.click();
  await page.getByRole('group', { name: en.effortLabel }).getByRole('menuitem', { name: en.effort_max }).click();
  await expect(modelPill).toHaveText(`Opus 5 · ${en.effort_max}`);
  await page.reload();
  await expect(modelPill).toHaveText(`Opus 5 · ${en.effort_max}`);
});

test('plan card: comment on it, approve from acceptEdits, one restoring mode message @controls', async ({ page }) => {
  const t = track(page);
  await open(page);
  await setMode(page, t, 'acceptEdits');
  await composer(page).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(pill(page)).toHaveText(en.mode_plan);
  await expect.poll(() => modeSends(t).at(-1)?.mode).toBe('plan');

  const text = `[plan] ${uniq('make a plan')}`;
  await send(page, text);
  const card = page.locator('[data-kind="plan-card"]');
  await expect(card).toBeVisible();
  const body = card.locator('[data-kind="plan"]');
  await expect(body.getByRole('heading', { name: 'The plan' })).toBeVisible();
  const approve = card.getByRole('button', { name: en.approvePlan(en.mode_acceptEdits) });
  await expect(approve).toBeVisible(); // it names the mode it will go back to

  // the plan is commentable like any reply
  await body.locator('p').first().evaluate((el) => {
    const node = el.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: /^💬/ }).click();
  await page.getByPlaceholder('Comment…').fill('plan comment e2e');
  await page.getByRole('button', { name: /^(Add|Добавить)$/ }).click();
  await expect(page.locator('[data-hl="pending"]')).toHaveCount(1);
  if ((await page.locator('#comments').getAttribute('data-open')) !== 'true') await page.locator('#toggleComments').click();
  const planCard = page.locator('#comments [data-comment-id]').filter({ hasText: 'plan comment e2e' });
  await expect(planCard).toHaveCount(1);
  await expect(planCard).toContainText('Step');

  // approve: the permission is answered, the CLI drops to default, the client puts the earlier mode back (once)
  const from = t.sent.length;
  await approve.click();
  await expect(card).toContainText(en.allowed);
  await expect.poll(() => t.sent.slice(from).filter((f) => f.type === 'permission' && f.allow === true).length).toBe(1);
  await expect(pill(page)).toHaveText(en.mode_acceptEdits);
  await expect(donesAfter(page, text).first()).toBeVisible();
  await expect(pill(page)).toHaveText(en.mode_acceptEdits);
  expect(modeSends(t, from).map((f) => f.mode)).toEqual(['acceptEdits']);
  // the server agrees (a reload reads the mode from it)
  await page.reload();
  await expect(pill(page)).toHaveText(en.mode_acceptEdits);
  // the comment is part of the server's session state: remove it so no later test sends it as a batch
  if ((await page.locator('#comments').getAttribute('data-open')) !== 'true') await page.locator('#toggleComments').click();
  await page.locator('#comments [data-comment-id]').filter({ hasText: 'plan comment e2e' }).getByRole('button', { name: /^(Delete|Удалить)$/ }).click();
  await expect(page.locator('#comments [data-comment-id]')).toHaveCount(0);
  await setMode(page, t, 'default');
});

test('prompt suggestion: ghost text in the idle empty composer, Tab fills it @controls', async ({ page }) => {
  await open(page);
  const text = `[suggest] ${uniq('suggest')}`;
  await send(page, text);
  await expect(donesAfter(page, text).first()).toBeVisible();
  await expect(composer(page)).toHaveAttribute('placeholder', 'now write the tests');
  await composer(page).focus();
  await expect(composer(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(composer(page)).toHaveValue('now write the tests');
  await expect(composer(page)).toBeFocused(); // Tab was taken by the composer, not by the browser
  // a typed draft is never overwritten by a late suggestion: with text in the field the ghost is gone
  await expect(composer(page)).not.toHaveAttribute('placeholder', 'now write the tests');
});

// M7-13 (R-M7-4): the server archives what a compaction cuts; a reloaded page gets the button, a live one keeps its feed
test('after a compaction and a reload, "Show before compaction" brings the earlier turn back @controls', async ({ page }) => {
  await open(page);
  const text = await turn(page, '', 'archived');
  const compact = page.getByRole('button', { name: en.compactTip });
  const markers = page.locator('[data-kind="marker"]').filter({ hasText: /context compacted/ });
  const n = await markers.count();
  await compact.click();
  await expect(markers).toHaveCount(n + 1);
  await expect(compact).toBeEnabled();
  const show = page.getByRole('button', { name: en.earlierShow });
  await expect(bubble(page, text)).toBeVisible(); // the live page still holds everything: no button
  await expect(show).toHaveCount(0);

  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(markers.last()).toBeVisible();
  await expect(bubble(page, text)).toHaveCount(0); // the replay starts at the boundary
  await show.click();
  await expect(bubble(page, text)).toBeVisible();
  await expect(donesAfter(page, text).first()).toBeVisible();
  // the earlier turn sits above the boundary line
  const order = await page.locator('[data-kind="user"], [data-kind="marker"]').evaluateAll((els, t) =>
    els.map((e) => (e.getAttribute('data-kind') === 'user' && e.textContent?.includes(t) ? 'turn' : e.getAttribute('data-kind'))), text);
  expect(order.indexOf('turn')).toBeLessThan(order.lastIndexOf('marker'));
});

test('compact adds its boundary line; clear asks first, empties the feed, gets a new session id and survives a reload @controls', async ({ page }) => {
  await open(page);
  const text = await turn(page, '', 'before compact');
  const compact = page.getByRole('button', { name: en.compactTip });
  const clear = page.getByRole('button', { name: en.clearTip });
  await compact.click();
  // the fake compacts for 1.5 s: the live line with its bar shows, then gives way to the boundary line with the time
  await expect(page.locator('[data-kind="compacting"]')).toContainText('compacting the context');
  await expect(page.locator('[data-kind="compacting"]').getByRole('progressbar')).toBeVisible();
  await expect(page.locator('[data-kind="marker"]').filter({ hasText: /context compacted · was 12k tokens · took 0:02/ })).toBeVisible();
  await expect(page.locator('[data-kind="compacting"]')).toHaveCount(0);
  await expect(compact).toBeEnabled(); // /compact is a turn: the buttons come back when it ends

  const before = (await page.locator('#session').textContent())?.trim();
  // cancel first: Esc closes the dialog and nothing is cleared
  await clear.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(en.clearTitle);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(bubble(page, text)).toBeVisible();

  await clear.click();
  await dialog.getByRole('button', { name: en.clearBtn }).click();
  await expect(page.locator('[data-kind="marker"]').filter({ hasText: /new conversation · context cleared/ })).toBeVisible();
  await expect(page.locator('[data-kind="user"]')).toHaveCount(0);
  await expect(bubble(page, text)).toHaveCount(0);
  await expect(page.locator('#session')).not.toHaveText(before ?? '');
  await expect(page.locator('#session')).toHaveText(/^[0-9a-f]{8}$/);

  // the old turns are not in the server's history any more
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(page.locator('[data-kind="empty"]')).toBeVisible();
  await expect(page.locator('[data-kind="user"]')).toHaveCount(0);
  await expect(page.locator('[data-kind="marker"]')).toHaveCount(0);
});

test('background tasks: the indicator counts, the drawer row ticks, a finished task stays as done @controls', async ({ page }) => {
  await open(page);
  const text = `[tasks] ${uniq('tasks')}`;
  await send(page, text);
  const ind = page.locator('#tasks-indicator');
  await expect(ind).toContainText('1 task');
  await ind.click();
  const row = page.locator('[data-task="t-e2e"]');
  await expect(row).toContainText('Explore the repo');
  await expect(row).toContainText('Grep');
  await expect(row).toContainText('5k tok'); // fmtK rounds 4500 to 5k
  await expect(row).toContainText(/[12]s · 5k tok/); // the elapsed time moves on by itself
  await expect(row).toHaveAttribute('data-status', 'done'); // task_notification ends it while the turn may still run
  await expect(ind).not.toContainText('task');
  await expect(donesAfter(page, text).first()).toBeVisible();
});

test('switching sessions: the file tabs follow the root, sends wait and the draft stays @controls', async ({ page }) => {
  const t = track(page);
  await open(page);
  const root = (p: Page) => p.locator('#root-path');

  // a file tab of this root
  // the tree starts open (R-M6-3) unless an earlier test closed it
  if (await page.locator('#tree-sheet').isHidden()) await page.locator('#toggleTree').click();
  await page.locator('button[data-path="notes.md"]').click();
  await expect(page.locator('[data-tab="file:notes.md"]')).toBeVisible();
  await page.locator('#toggleTree').click();

  const pickSession = async (title: string) => {
    await page.locator('#sessBtn').click();
    await page.locator('[data-sess-item]').filter({ hasText: title }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(title);
    await dialog.getByRole('button', { name: en.switchBtn }).click();
  };

  await pickSession('Beta session');
  // the fake delays the new session's history by 1.5 s: this is the switching window
  await expect(page.locator('#conn')).toHaveText(en.switching);
  await expect(composer(page)).toBeFocused(); // the confirm hands focus to the composer, the draft waits there
  const sentBefore = t.sent.filter((f) => f.type === 'send').length;
  const draft = `draft ${uniq('kept')}`;
  await page.keyboard.type(draft);
  await page.keyboard.press('Enter');
  await expect(page.locator('footer').getByRole('button', { name: en.send, exact: true })).toBeDisabled();
  await expect(page.locator('#conn')).toHaveText(en.switching); // still inside the window: the Enter was refused by it
  expect(t.sent.filter((f) => f.type === 'send').length).toBe(sentBefore);
  await expect(bubble(page, draft)).toHaveCount(0);

  // the switch completes: Beta's replay, its root, no tab of the old root
  await expect(page.locator('#conn')).toHaveText('');
  await expect(page.getByText('beta answer')).toBeVisible();
  await expect(root(page)).toHaveText(/\/other$/);
  await expect(page.locator('#proj')).toHaveText('other');
  await expect(composer(page)).toHaveValue(draft);
  expect(t.sent.filter((f) => f.type === 'send').length).toBe(sentBefore);
  await expect(page.locator('[data-tab="file:notes.md"]')).toHaveCount(0);
  await expect(page.locator('[role="tab"]')).toHaveCount(1); // only the chat

  // the new root has its own tabs
  // the tree starts open (R-M6-3) unless an earlier test closed it
  if (await page.locator('#tree-sheet').isHidden()) await page.locator('#toggleTree').click();
  await page.locator('button[data-path="other.md"]').click();
  await expect(page.locator('[data-tab="file:other.md"]')).toBeVisible();
  await page.locator('#toggleTree').click();

  // and back: the first root's tab returns, the other root's goes
  await pickSession('Alpha session');
  await expect(page.locator('#conn')).toHaveText(en.switching);
  await expect(page.locator('#conn')).toHaveText('');
  await expect(root(page)).not.toHaveText(/\/other$/);
  // the saved tabs of this root come back, with notes.md active: the chat is behind it
  await expect(page.locator('[data-tab="file:notes.md"]')).toBeVisible();
  await page.locator('[data-tab="chat"]').click();
  await expect(page.getByText('alpha answer')).toBeVisible();
  await expect(page.locator('[data-tab="file:other.md"]')).toHaveCount(0);
});
