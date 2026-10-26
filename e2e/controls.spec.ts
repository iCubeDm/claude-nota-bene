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
  await setMode(page, t, 'default');
});

test('Shift+Tab cycles the modes in order and the other window follows the server echo @controls', async ({ page, context }) => {
  const t = track(page);
  await open(page);
  await setMode(page, t, 'default');
  const other = await context.newPage();
  await open(other);
  await expect(pill(other)).toHaveText(en.mode_default);

  await composer(page).focus();
  await expect(composer(page)).toBeFocused();
  const from = t.sent.length;
  for (const mode of ['acceptEdits', 'plan', 'auto', 'default'] as const) {
    await page.keyboard.press('Shift+Tab');
    await expect(pill(page)).toHaveText(en[`mode_${mode}`]);
    // the second window has no key press of its own: it can only know from the server's broadcast
    await expect(pill(other)).toHaveText(en[`mode_${mode}`]);
  }
  expect(modeSends(t, from).map((f) => f.mode)).toEqual(['acceptEdits', 'plan', 'auto', 'default']);
  await expect(composer(page)).toBeFocused(); // Shift+Tab never moves the focus away
  await other.close();
});

test('an init frame with permissionMode changes the pill @controls', async ({ page }) => {
  const t = track(page);
  await open(page);
  await setMode(page, t, 'default');
  const from = t.sent.length;
  await turn(page, '[initmode]');
  await expect(pill(page)).toHaveText(en.mode_acceptEdits);
  expect(modeSends(t, from)).toEqual([]); // the CLI changed it: the client only follows
  await setMode(page, t, 'default'); // leave the server as the other tests expect it
});

test('Shift+Tab yields to an open @ picker (it takes the key), then works again @controls', async ({ page }) => {
  const t = track(page);
  await open(page);
  await setMode(page, t, 'default');
  await composer(page).focus();
  await expect(composer(page)).toBeFocused();
  const from = t.sent.length;
  await page.keyboard.type('@no'); // typed, not filled: the picker listens to real input events
  const option = page.getByRole('option').filter({ hasText: 'notes.md' });
  await expect(option).toBeVisible();

  await page.keyboard.press('Shift+Tab');
  // the picker took the key (it inserted the pick): no mode change, none sent
  await expect(composer(page)).toHaveValue('@notes.md ');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(pill(page)).toHaveText(en.mode_default);
  expect(modeSends(t, from)).toEqual([]);

  // with the picker gone the same key cycles again
  await page.keyboard.press('Shift+Tab');
  await expect(pill(page)).toHaveText(en.mode_acceptEdits);
  await expect.poll(() => modeSends(t, from).map((f) => f.mode)).toEqual(['acceptEdits']);
  await setMode(page, t, 'default');
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

test('context meters: 65 % warns, 90 % is hot @controls', async ({ page }) => {
  await open(page);
  const meter = page.getByRole('meter', { name: /^context \d+%/ });
  await turn(page, '[warn]');
  await expect(meter).toHaveAttribute('aria-valuenow', '65');
  await expect(meter).toHaveAttribute('data-level', 'warn');
  await turn(page, '[hot]');
  await expect(meter).toHaveAttribute('aria-valuenow', '90');
  await expect(meter).toHaveAttribute('data-level', 'hot');
  await expect(meter).toHaveClass(/\bhot\b/);
  // a new window gets the last measurement from the server straight away
  await page.reload();
  await expect(page.getByRole('meter', { name: /^context 90%/ })).toHaveAttribute('data-level', 'hot');
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

test('background tasks: the row appears, ticks and disappears @controls', async ({ page }) => {
  await open(page);
  const row = page.getByRole('status', { name: en.tasksLabel });
  const text = `[tasks] ${uniq('tasks')}`;
  await send(page, text);
  await expect(row).toContainText('Explore the repo');
  await expect(row).toContainText('Grep');
  await expect(row).toContainText('5k tok'); // fmtK rounds 4500 to 5k
  await expect(row).toContainText(/[12]s · 5k tok/); // the elapsed time moves on by itself
  await expect(row).toBeHidden(); // task_notification removes it while the turn may still run
  await expect(donesAfter(page, text).first()).toBeVisible();
});

test('a server error is one toast; the same error again is ×2; a busy refusal is no toast @controls', async ({ page }) => {
  const t = track(page);
  await open(page);
  const first = `[boom] ${uniq('crash')}`;
  await send(page, first);
  await expect(toasts(page)).toHaveCount(1);
  await expect(toasts(page)).toContainText('Server error · agent');
  await expect(toasts(page)).toContainText('fake backend crash');
  await expect(toasts(page)).not.toContainText('×');
  // not a feed notice any more
  await expect(page.locator('[data-kind="notice"]').filter({ hasText: 'fake backend crash' })).toHaveCount(0);
  await expect(donesAfter(page, first).first()).toBeVisible();

  const second = `[boom] ${uniq('crash again')}`;
  await send(page, second);
  await expect(toasts(page)).toContainText('×2');
  await expect(toasts(page)).toHaveCount(1); // deduplicated, not stacked
  await expect(donesAfter(page, second).first()).toBeVisible();
  await toasts(page).getByRole('button', { name: en.close }).click();
  await expect(toasts(page)).toHaveCount(0);

  // busy: another socket asks for /compact while the agent works; the server answers `busy` to every window
  const slow = `[slow] ${uniq('slow')}`;
  await send(page, slow);
  await expect(page.getByText(en.working)).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'command', name: 'compact' }));
      setTimeout(() => { ws.close(); resolve(); }, 200);
    };
  }));
  await expect.poll(() => t.got.some((f) => f.kind === 'server-error' && f.where === 'busy')).toBe(true);
  await expect(toasts(page)).toHaveCount(0);
  await expect(donesAfter(page, slow).first()).toBeVisible();
  await expect(toasts(page)).toHaveCount(0);
});

test('switching sessions: both pages follow, the file tabs follow the root, sends wait and the draft stays @controls', async ({ page, context }) => {
  const t = track(page);
  await open(page);
  const other = await context.newPage();
  await open(other);
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
  // the second page was not asked anything and follows the server
  await expect(root(other)).toHaveText(/\/other$/);
  await expect(other.getByText('beta answer')).toBeVisible();
  await expect(other.getByText('alpha answer')).toHaveCount(0);

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
  await expect(root(other)).not.toHaveText(/\/other$/);
  await expect(other.getByText('alpha answer')).toHaveCount(1); // in the DOM; the page may show a restored file tab over it
  await expect(other.getByText('beta answer')).toHaveCount(0);
  await other.close();
});
