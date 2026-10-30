import { expect, test } from '@playwright/test';

// Experimental 3D is off by default (NOTA_BENE_EXPERIMENTAL_3D unset; the controls fixture runs with it off and holds models/cube.glb):
// a model file is an ordinary unsupported file, /model is a 404, Blender is never looked up, and no 3D chunk is fetched.
test('experimental 3D off: a .glb opens as a plain file, /model is 404, no 3D chunk loads @controls', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname + new URL(r.url()).search));
  await page.goto('/');
  await expect(page.locator('#composer-input')).toBeVisible();

  const info = (await (await page.request.get('/info')).json()) as { blender: boolean };
  expect(info.blender).toBe(false);
  expect((await page.request.get('/model?path=models%2Fcube.glb')).status()).toBe(404);

  const sheet = page.locator('#tree-sheet');
  if (await sheet.isHidden()) await page.locator('#toggleTree').click();
  await expect(sheet).toBeVisible();
  const dir = sheet.locator('button[data-path="models"]');
  if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
  await expect(sheet.locator('button[data-path="models/cube.glb"] [data-icon="model"]')).toHaveCount(0);
  await sheet.locator('button[data-path="models/cube.glb"]').click();
  const tab = page.locator('[data-tab="file:models/cube.glb"]');
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.locator('#toggleTree').click();

  const pane = page.locator('[data-pane="file:models/cube.glb"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('canvas, [data-model-host], [data-model-ready]')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(requested.filter((u) => /\/assets\/(ModelBody|viewer)-|\/model\b/.test(u))).toEqual([]);
});
