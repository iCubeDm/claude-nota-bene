import { createHmac, randomBytes } from "node:crypto";
// Shared helpers: the demo server, a fake cursor, pacing, and the video -> GIF conversion.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeScript, writeProject } from './project.mjs';
import { makeAssets } from './assets.mjs';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const PORT = 4790;
export const URL_BASE = `http://127.0.0.1:${PORT}`;
// the login a window opened by the launcher would get: the fragment carries it, POST /auth accepts it
const TOKEN = randomBytes(32).toString("hex");
const NONCE = randomBytes(16).toString("hex");
export const LOGIN_URL = `${URL_BASE}/#t=${createHmac("sha256", TOKEN).update(`nota-bene:login:${PORT}:${NONCE}`).digest("hex")}`;
/** A neutral path with no user name in it: it is what the window shows as the project. Removed again at the end of a run. */
export const PROJECT = '/Users/Shared/demo-project';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Creates the demo project (fresh each time) and a temp state dir; returns both. Assets are generated once per run. */
export async function prepare(chromium, work) {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  writeProject(PROJECT);
  await makeAssets(chromium, PROJECT);
  const script = path.join(work, 'fake.json');
  fs.writeFileSync(script, JSON.stringify(fakeScript()));
  return { script };
}

/** Starts a server on 4790 (waits while another agent holds the port) with a fresh state dir. Returns { stop(), home }. */
export async function startServer(work, script, name) {
  fs.rmSync(path.join(PROJECT, '.nota-bene'), { recursive: true, force: true }); // marks of an earlier scene
  const home = fs.mkdtempSync(path.join(work, `home-${name}-`));
  const vault = fs.mkdtempSync(path.join(work, `vault-${name}-`));
  for (let attempt = 0; ; attempt++) {
    if (!(await portBusy())) break;
    if (attempt > 60) throw new Error(`port ${PORT} stays busy`);
    console.log(`port ${PORT} busy, waiting…`);
    await sleep(5000);
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "token"), TOKEN, { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(REPO, 'server/src/main.ts'), PROJECT, '--port', String(PORT), '--fake', script], {
    cwd: REPO,
    env: { ...process.env, NOTA_BENE_HOME: home, NOTA_BENE_NONCE: NONCE, CLAUDE_JOURNAL_VAULT: vault, NOTA_BENE_EXPERIMENTAL_3D: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 100; i++) {
    if (await portBusy()) break;
    await sleep(100);
  }
  return {
    home,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000).unref(); });
    },
  };
}

async function portBusy() {
  try {
    const r = await fetch(`${URL_BASE}/info`);
    return r.ok || true;
  } catch {
    return false;
  }
}

/** A visible cursor (an arrow with a click ripple) that follows the real mouse events Playwright dispatches. */
export const CURSOR_INIT = `
(() => {
  const mk = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28"><path d="M5 3 L5 22 L10 17.5 L13.6 25 L17 23.4 L13.4 16 L20 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const style = document.createElement('style');
    style.textContent = '@keyframes demo-ripple{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}to{transform:translate(-50%,-50%) scale(1.5);opacity:0}}';
    document.documentElement.appendChild(style);
    const move = (e) => { c.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)'; window.__demoPos = [e.clientX, e.clientY]; };
    addEventListener('mousemove', move, true);
    addEventListener('mousedown', (e) => {
      move(e);
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;border-radius:50%;border:2px solid rgba(120,170,255,.95);background:rgba(120,170,255,.25);left:' + e.clientX + 'px;top:' + e.clientY + 'px;animation:demo-ripple .5s ease-out forwards';
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.documentElement) mk(); else addEventListener('DOMContentLoaded', mk);
})();
`;

/** Moves the mouse smoothly (ease in-out) to (x, y) in about `ms`, so the viewer can follow the pointer. */
export async function glide(page, x, y, ms = 700) {
  const from = (await page.evaluate(() => window.__demoPos)) ?? [x, y - 150];
  const t0 = Date.now();
  for (;;) {
    const t = Math.min(1, (Date.now() - t0) / ms);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(from[0] + (x - from[0]) * e, from[1] + (y - from[1]) * e);
    if (t >= 1) break;
  }
}

export async function glideTo(page, locator, ms = 700, where = [0.5, 0.5]) {
  const b = await locator.boundingBox();
  await glide(page, b.x + b.width * where[0], b.y + b.height * where[1], ms);
}

export async function clickAt(page, locator, ms = 700) {
  await glideTo(page, locator, ms);
  await sleep(90);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(160);
}

/** Types at a visible speed (ms per character, a little uneven). */
export async function typeSlow(locator, text, ms = 55) {
  for (const ch of text) {
    await locator.pressSequentially(ch);
    await sleep(ms + (ch === ' ' ? 25 : 0));
  }
}

/**
 * Screencast frames ({file, t} in epoch seconds, a frame is held until the next) to a looping GIF: the part between
 * marks.from and marks.to, plus `hold` seconds on the last frame, 3200 px wide (no downscale of the 3200 px capture), 12 fps, one palette for the whole clip, a short
 * fade from and to the window's background colour so the loop does not jump. Returns the duration in seconds.
 */
export function framesToGif(frames, marks, gif, dir, { hold = 1.5, width = 3200, fps = 12, bg = '0x0b0e17' } = {}) {
  const inRange = frames.filter((f) => f.t < marks.to);
  let start = 0;
  while (start + 1 < inRange.length && inRange[start + 1].t <= marks.from) start++;
  const used = inRange.slice(start);
  const lines = [];
  used.forEach((f, i) => {
    const next = i + 1 < used.length ? used[i + 1].t : marks.to;
    const d = Math.max(0.001, next - Math.max(f.t, marks.from));
    lines.push(`file '${f.file}'`, `duration ${d.toFixed(4)}`);
  });
  lines.push(`file '${used.at(-1).file}'`, `duration ${hold}`, `file '${used.at(-1).file}'`);
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, lines.join('\n'));
  const dur = marks.to - marks.from + hold;
  const vf = [
    `fps=${fps}`,
    `scale=${width}:-1:flags=lanczos`,
    `fade=t=in:st=0:d=0.3:color=${bg}`,
    `fade=t=out:st=${(dur - 0.35).toFixed(2)}:d=0.35:color=${bg}`,
  ].join(',');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-t', dur.toFixed(2), '-filter_complex',
    `[0:v]${vf},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif]);
  return dur;
}

export { os };
