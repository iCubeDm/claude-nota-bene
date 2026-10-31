import { test, expect } from '@playwright/test';
// Separate config reuses the serial test port after the Claude suite has shut down.
test('Codex browser: native controls, typed questions, stable replay and files @codex', async ({ page }) => {
  const frames: Record<string, unknown>[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => { try { frames.push(JSON.parse(String(f.payload))); } catch {} }));
  await page.goto('/');
  const composer = page.getByPlaceholder(/Message the agent/);
  await expect(page.getByText('Codex config', { exact: true })).toBeVisible();
  await expect(page.getByText('Codex config', { exact: true })).toBeVisible();
  await composer.fill('question'); await composer.press('Enter');
  await expect(page.getByLabel('Which colour?')).toBeVisible();
  await page.getByLabel('Which colour?').fill('Green');
  await page.getByRole('button', { name: 'Send answers' }).click();
  await expect(page.getByText('Answer: Green', { exact: true })).toBeVisible();
  await expect.poll(() => frames.some((m) => m.type === 'permission' && JSON.stringify(m.response).includes('Green'))).toBe(true);
  await expect(page.getByRole('meter', { name: '2h 23%' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Answer: Green', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Which colour?')).toHaveCount(0);
  await page.getByText('notes.md', { exact: true }).click();
  await expect(page.getByText('Review file', { exact: true })).toBeVisible();
});
