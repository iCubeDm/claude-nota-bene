// Regenerates the README / user-guide media in docs/media/ (GIFs and PNGs) from the real UI, with no real agent.
//
//   node scripts/demo-media/make.mjs [--only annotate-text,overview,...] [--out docs/media]
//
// Needs: Node >= 23.6, system Chrome (Playwright drives it, nothing is downloaded), ffmpeg on PATH, `npm install` done,
// and `npm run build -w web` (done here when web/dist is missing or older than web/src).
// It starts the server on port 4790 with the fake backend (--fake, scripted replies), a temp state dir and a temp journal
// vault, and a demo project it creates at /Users/Shared/demo-project (removed at the end) (a tiny URL shortener, with a generated image and video).
// If 4790 is busy it waits and retries. Nothing outside /tmp and the output folder is touched.
//
// Scenes: annotate-text.gif (hero), annotate-code.gif, annotate-image.gif, annotate-video.gif, overview.png, slash-menu.png.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { CURSOR_INIT, PROJECT, REPO, URL_BASE, LOGIN_URL, clickAt, glide, glideTo, prepare, sleep, startServer, framesToGif, typeSlow } from './lib.mjs';
import { TEXT } from './project.mjs';
import { flowHtml, landingHtml } from './assets.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const only = opt('--only')?.split(',');
const OUT = path.resolve(REPO, opt('--out') ?? 'docs/media');
fs.mkdirSync(OUT, { recursive: true });
const T0 = Date.now();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-demo-media-'));

// ---- the page ----------------------------------------------------------------------------------------------------
const composer = (p) => p.getByPlaceholder(/Message the agent/);
const panel = (p) => p.locator('#comments');
const cards = (p) => panel(p).locator('[data-comment-id]');
const commentBox = (p) => p.getByPlaceholder('Comment…');
const addBtn = (p) => p.getByRole('button', { name: /^Add$/ });
const doneLines = (p) => p.locator('[data-kind="done"]');

/** Hides what looks like a test artifact: the (fake) session id in the header. */
const HIDE = '#session { visibility: hidden }';

async function openPage(browser, { record = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US', colorScheme: 'dark',
  });
  await ctx.addInitScript(CURSOR_INIT);
  await ctx.addInitScript(() => { try { localStorage.setItem('lang', 'en'); } catch {} });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(LOGIN_URL);
  await page.addStyleTag({ content: HIDE });
  await composer(page).waitFor();
  return { ctx, page, t0, since: () => (Date.now() - t0) / 1000 };
}

/** Sends a message quickly (setup, not for the viewer) and waits until the turn is done. */
async function ask(page, text) {
  const n = await doneLines(page).count();
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await page.waitForFunction((k) => document.querySelectorAll('[data-kind="done"]').length > k, n, { timeout: 60000 });
}

async function waitDone(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll('[data-kind="done"]').length >= k, n, { timeout: 60000 });
  await sleep(300);
}

/** The client rects (one per line) of `phrase` inside the element matching `rootSel`; the phrase may span several text nodes. */
async function phraseRects(page, rootSel, phrase, nth = 0) {
  return page.evaluate(([sel, ph, k]) => {
    const list = document.querySelectorAll(sel);
    const root = list[k < 0 ? list.length + k : k];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; let full = '';
    for (let n; (n = w.nextNode());) { nodes.push([n, full.length]); full += n.data; }
    const i = full.indexOf(ph);
    if (i < 0) throw new Error(`phrase not found: ${ph}`);
    const at = (pos) => { for (let j = nodes.length - 1; j >= 0; j--) if (nodes[j][1] <= pos) return [nodes[j][0], pos - nodes[j][1]]; };
    const [a, ao] = at(i); const [b, bo] = at(i + ph.length - 1);
    const r = document.createRange(); r.setStart(a, ao); r.setEnd(b, bo + 1);
    root.scrollIntoView({ block: 'nearest' });
    return [...r.getClientRects()].map((x) => [x.x, x.y, x.width, x.height]);
  }, [rootSel, phrase, nth]);
}

/** Selects `phrase` with a real mouse drag, at a pace one can follow. */
async function dragSelect(page, rootSel, phrase, nth = 0) {
  const rects = await phraseRects(page, rootSel, phrase, nth);
  const [x0, y0, , h0] = rects[0];
  const [x1, y1, w1, h1] = rects.at(-1);
  await glide(page, x0 - 1, y0 + h0 / 2, 550);
  await sleep(150);
  await page.mouse.down();
  await glide(page, x1 + w1 + 1, y1 + h1 / 2, 500);
  await sleep(80);
  await page.mouse.up();
  await sleep(300);
}

/** Comment popup flow after a selection: click Comment, type, click Add. */
async function commentOnSelection(page, text) {
  console.log('  comment', ((Date.now() - T0) / 1000).toFixed(1));
  await clickAt(page, page.getByRole('button', { name: /^💬/ }), 450);
  await commentBox(page).waitFor();
  await sleep(200);
  await typeSlow(commentBox(page), text, 24);
  await sleep(250);
  await clickAt(page, addBtn(page), 450);
  await sleep(350);
}

async function openFile(page, filePath) {
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = page.locator(`button[data-path="${parts.slice(0, i).join('/')}"]`);
    if ((await dir.getAttribute('aria-expanded')) !== 'true') await clickAt(page, dir, 550);
  }
  await clickAt(page, page.locator(`button[data-path="${filePath}"]`), 550);
  await sleep(250);
}

/** Opens the tree panel's folders (setup, off camera). */
async function expand(page, ...dirs) {
  for (const d of dirs) await page.locator(`button[data-path="${d}"]`).click();
}

/** Closes the file tree to give the open file the room (a click on its tool button, on camera). */
async function closeTree(page) {
  await clickAt(page, page.locator('#toggleTree'), 400);
  await sleep(150);
}

async function sendBatch(page) {
  await clickAt(page, page.locator('#cSend'), 650);
}

/**
 * Records a scene as a CDP screencast (Playwright's own video needs a separate ffmpeg download, which is not used here).
 * `setupThenPlay(page, start)` calls `start()` when the viewer's part begins; it returns when the final state is on screen.
 */
async function recordGif(browser, name, setupThenPlay) {
  const { ctx, page } = await openPage(browser, { record: true });
  const cdp = await ctx.newCDPSession(page);
  const dir = fs.mkdtempSync(path.join(work, `frames-${name}-`));
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 3200, maxHeight: 2000, everyNthFrame: 1 });
  const marks = {};
  try { await setupThenPlay(page, () => { marks.from = Date.now() / 1000; }); } catch (e) { if (process.env.DEMO_DEBUG) await page.screenshot({ path: `/tmp/nbx/fail-${name}.png` }); throw e; }
  marks.to = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await page.close();
  await ctx.close();
  const gif = path.join(OUT, `${name}.gif`);
  const dur = framesToGif(frames, marks, gif, dir);
  console.log(`${name}.gif  ${dur.toFixed(1)} s  ${(fs.statSync(gif).size / 1e6).toFixed(2)} MB`);
}

// ---- scenes ------------------------------------------------------------------------------------------------------
const scenes = {
  async 'annotate-text'(browser) {
    await recordGif(browser, 'annotate-text', async (page, start) => {
      await ask(page, TEXT.intro);
      await ask(page, TEXT.ask);
      await page.mouse.move(800, 800);
      await sleep(300);
      start();
      await sleep(400); // the reply, as the viewer arrives
      const reply = '[data-kind="assistant"]';
      const L = (m) => console.log('  ', m, ((Date.now() - T0) / 1000).toFixed(1));
      L('start');
      await dragSelect(page, reply, 'retries up to five times and then throws an error.', -1);
      L('sel1');
      await commentOnSelection(page, TEXT.heroC1);
      L('c1');
      await dragSelect(page, reply, 'a restart loses every link.', -1);
      L('sel2');
      await commentOnSelection(page, TEXT.heroC2);
      L('c2');
      await sleep(500);
      await sendBatch(page);
      L('sent');
      await waitDone(page, 2);
      L('done');
      await sleep(200);
    });
  },

  async 'annotate-code'(browser) {
    await recordGif(browser, 'annotate-code', async (page, start) => {
      await expand(page, 'src');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, 'src/store.ts');
      await closeTree(page);
      const code = '[data-file-path="src/store.ts"] pre';
      await sleep(400);
      await dragSelect(page, code, 'if (links.has(code)) continue;');
      await commentOnSelection(page, TEXT.codeC);
      await sleep(500);
      await sendBatch(page);
      await waitDone(page, 1);
      await sleep(200);
    });
  },

  async 'annotate-image'(browser) {
    await recordGif(browser, 'annotate-image', async (page, start) => {
      await expand(page, 'design');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, 'design/landing.png');
      await closeTree(page);
      const img = page.locator('[data-pane="file:design/landing.png"] img');
      await img.waitFor();
      await sleep(500);
      await clickAt(page, page.getByRole('button', { name: /^Mark up$/ }), 600);
      await page.locator('svg[data-markup-layer]').waitFor();
      await sleep(150);
      // the Shorten button (and, in the video, the result card): natural px of the picture -> client px of the shown image
      const b = await img.boundingBox();
      const box = await naturalBox(browser, landingHtml(), 800, 540, '.cta', 8);
      const k = b.width / 800;
      await drawRect(page, b.x + box.x * k, b.y + box.y * k, box.width * k, box.height * k);
      await commentOnMark(page, TEXT.imgC);
      await page.keyboard.press('Escape');
      await sleep(250);
      await sendBatch(page);
      await waitDone(page, 1);
      await sleep(200);
    });
  },

  async 'annotate-video'(browser) {
    await recordGif(browser, 'annotate-video', async (page, start) => {
      await expand(page, 'media');
      await page.mouse.move(300, 600);
      start();
      await sleep(300);
      await openFile(page, 'media/flow.mp4');
      await closeTree(page);
      const video = page.locator('[data-pane="file:media/flow.mp4"] video');
      await video.waitFor();
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      await video.evaluate((e) => { e.muted = true; });
      const playBtn = page.locator('[data-player-bar] button').first();
      await sleep(150);
      // play, and pause once the result is up
      await clickAt(page, playBtn, 450);
      await page.waitForFunction(() => document.querySelector('video').currentTime >= 2.7);
      await playBtn.click();
      await page.waitForFunction(() => document.querySelector('video').paused);
      await sleep(150);
      await clickAt(page, page.getByRole('button', { name: /^Mark up$/ }), 600);
      await page.locator('svg[data-markup-layer]').waitFor();
      await sleep(150);
      const vb = await contentBox(video);
      const r = await naturalBox(browser, flowHtml(), 800, 500, '#r', 6);
      const k = vb.width / 800;
      await drawRect(page, vb.x + r.x * k, vb.y + r.y * k, r.width * k, r.height * k);
      await commentOnMark(page, TEXT.vidC);
      await page.keyboard.press('Escape');
      await sleep(250);
      await sendBatch(page);
      await waitDone(page, 1);
      await sleep(200);
    });
  },

  async overview(browser) {
    const { ctx, page } = await openPage(browser);
    await ask(page, TEXT.intro);
    await ask(page, TEXT.ask);
    await expand(page, 'src');
    await openFile(page, 'src/store.ts');
    await dragSelect(page, '[data-file-path="src/store.ts"] pre', 'if (links.has(code)) continue;');
    await commentOnSelection(page, TEXT.codeC);
    await page.locator('[data-tab="chat"]').click();
    await sleep(300);
    const reply = '[data-kind="assistant"]';
    for (const [phrase, text] of [['retries up to five times and then throws an error.', TEXT.heroC1], ['a restart loses every link.', TEXT.heroC2]]) {
      await dragSelect(page, reply, phrase, -1);
      await commentOnSelection(page, text);
    }
    await page.mouse.move(1100, 900);
    await sleep(600);
    await page.evaluate(() => document.getElementById('demo-cursor')?.remove());
    await page.screenshot({ path: path.join(OUT, 'overview.png') });
    await ctx.close();
  },

  async 'slash-menu'(browser) {
    const { ctx, page } = await openPage(browser);
    await ask(page, TEXT.ask);
    await composer(page).click();
    await composer(page).pressSequentially('/');
    await page.getByRole('listbox').first().waitFor();
    await sleep(500);
    await page.evaluate(() => document.getElementById('demo-cursor')?.remove());
    await page.screenshot({ path: path.join(OUT, 'slash-menu.png') });
    await ctx.close();
  },
};

// ---- drawing on media ----------------------------------------------------------------------------------------------
async function drawRect(page, x, y, w, h) {
  const pad = 6;
  await glide(page, x - pad, y - pad, 550);
  await sleep(150);
  await page.mouse.down();
  await page.mouse.move(x + w + pad, y + h + pad, { steps: 26 });
  await sleep(100);
  await page.mouse.up();
  await sleep(300);
}

/** After a drawing: Enter opens the comment box, type, click Add. */
async function commentOnMark(page, text) {
  await page.keyboard.press('Enter');
  await commentBox(page).waitFor();
  await sleep(350);
  await typeSlow(commentBox(page), text, 24);
  await sleep(250);
  await clickAt(page, addBtn(page), 450);
  await sleep(500);
}

/** Box of `sel` in a page rendered from `html` (natural px), grown by `pad`. */
async function naturalBox(browser, html, w, h, sel, pad = 0) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(html);
  if (html.includes('window.render')) await p.evaluate(() => window.render(5));
  const b = await p.locator(sel).first().boundingBox();
  await p.close();
  return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}

/** The picture's content box in client px (object-fit: contain). */
const contentBox = (media) => media.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const [w, h] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
  const s = Math.min(r.width / w, r.height / h);
  return { x: r.x + (r.width - w * s) / 2, y: r.y + (r.height - h * s) / 2, width: w * s, height: h * s };
});

// ---- main ----------------------------------------------------------------------------------------------------------
function ensureBuilt() {
  const dist = path.join(REPO, 'web/dist/index.html');
  const newest = (dir) => execFileSync('find', [dir, '-type', 'f', '-newer', dist], { encoding: 'utf8' }).trim();
  if (!fs.existsSync(dist) || newest(path.join(REPO, 'web/src'))) execFileSync('npm', ['run', 'build', '-w', 'web'], { cwd: REPO, stdio: 'inherit' });
}

ensureBuilt();
const { script } = await prepare(chromium, work);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let failed = false;
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (only && !only.includes(name)) continue;
    const srv = await startServer(work, script, name); // fresh state per scene
    try {
      await run(browser);
    } catch (e) {
      failed = true;
      console.error(`${name} failed:`, e);
    } finally {
      await srv.stop();
    }
  }
} finally {
  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(PROJECT, { recursive: true, force: true });
}
if (failed) process.exit(1);
