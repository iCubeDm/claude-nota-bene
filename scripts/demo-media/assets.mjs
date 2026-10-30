// The demo project's image and video, drawn here from HTML (original, simple): a landing-page design mock and a short
// screen-recording-style animation of the same page. Rendered with the same Chrome Playwright drives.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CSS = `
* { box-sizing: border-box; margin: 0; }
body { width: var(--w); height: var(--h); overflow: hidden; background: #f4f5fa; color: #1f2430;
  font: 16px/1.5 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", sans-serif; }
nav { height: 64px; display: flex; align-items: center; padding: 0 56px; gap: 32px; background: #fff; border-bottom: 1px solid #e4e6ee; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; letter-spacing: -.01em; }
.logo i { width: 26px; height: 26px; border-radius: 8px; background: linear-gradient(135deg, #6d63f5, #4338ca); display: block; position: relative; }
.logo i::after { content: ""; position: absolute; left: 7px; top: 12px; width: 12px; height: 3px; border-radius: 2px; background: #fff; }
nav a { color: #5a6072; text-decoration: none; font-size: 15px; }
nav .sp { flex: 1; }
nav .signin { color: #4338ca; font-weight: 600; }
main { padding: 56px 56px 0; text-align: center; }
h1 { font-size: 46px; line-height: 1.12; letter-spacing: -.025em; }
.sub { margin-top: 12px; color: #5a6072; font-size: 18px; }
.form { margin: 40px auto 0; width: 760px; display: flex; gap: 12px; padding: 10px; background: #fff; border: 1px solid #dfe2ec;
  border-radius: 14px; box-shadow: 0 10px 30px rgba(40,44,90,.08); align-items: center; }
.field { flex: 1; text-align: left; padding: 0 14px; height: 48px; display: flex; align-items: center; color: #9aa0b4; font-size: 17px; white-space: nowrap; overflow: hidden; }
.field.typed { color: #1f2430; }
.caret { display: inline-block; width: 2px; height: 22px; background: #4338ca; margin-left: 1px; vertical-align: middle; }
.cta { height: 36px; padding: 0 16px; border: 1px solid #c9ccd6; border-radius: 6px; background: #fff; color: #3b4054; font-size: 13px; font-weight: 600; font-family: inherit; }
.result { margin: 28px auto 0; width: 760px; background: #fff; border: 1px solid #dfe2ec; border-radius: 14px; padding: 18px 24px; display: flex; align-items: center; gap: 16px; text-align: left; }
.result .code { font-size: 22px; font-weight: 700; color: #4338ca; letter-spacing: -.01em; }
.result .orig { color: #8a90a4; font-size: 14px; margin-top: 2px; }
.result .sp { flex: 1; }
.pill { background: #eceeff; color: #4338ca; border-radius: 999px; padding: 6px 14px; font-size: 14px; font-weight: 600; }
.chips { margin: 36px auto 0; width: 760px; display: flex; gap: 16px; }
.chip { flex: 1; background: #fff; border: 1px solid #e4e6ee; border-radius: 12px; padding: 16px 18px; text-align: left; }
.chip b { display: block; font-size: 15px; margin-bottom: 2px; }
.chip span { color: #6b7185; font-size: 14px; }
`;

const page = (w, h, body, extra = '') => `<!doctype html><meta charset=utf-8><style>:root{--w:${w}px;--h:${h}px}${CSS}${extra}</style>${body}`;

const NAV = `<nav><div class="logo"><i></i>shortly</div><a>Docs</a><a>Pricing</a><a>API</a><span class="sp"></span><a class="signin">Sign in</a></nav>`;

export function landingHtml() {
  return page(800, 540, `${NAV}<main style="padding-top:36px">
    <h1 style="font-size:34px">Short links,<br>made simple.</h1>
    <p class="sub" style="font-size:16px;margin-top:8px">Paste a long address, get a short one you can say out loud.</p>
    <div class="form" style="width:660px;margin-top:28px"><div class="field">Paste a long URL here…</div><button class="cta">Shorten</button></div>
    <div class="result" style="width:660px"><div><div class="code">shortly.example/k7m2xq</div><div class="orig">example.com/blog/2026/how-we-ship-small-changes</div></div><span class="sp"></span><span class="pill">0 clicks</span></div>
    </main>`);
}

const URL_TEXT = 'https://example.com/blog/2026/how-we-ship-small-changes';

/** One frame of the flow at time t seconds (6 s): type the URL, press Shorten, the result appears at once. */
export function flowHtml() {
  return page(800, 500, `${NAV}<main style="padding-top:32px">
    <h1 style="font-size:34px">Short links,<br>made simple.</h1>
    <div class="form" style="width:660px;margin-top:26px"><div class="field" id="f"></div><button class="cta" id="b">Shorten</button></div>
    <div class="result" id="r" style="width:660px;visibility:hidden"><div><div class="code">shortly.example/k7m2xq</div><div class="orig">example.com/blog/2026/how-we-ship-small-changes</div></div><span class="sp"></span><span class="pill">0 clicks</span></div>
    </main>
    <script>
      const URL_TEXT = ${JSON.stringify(URL_TEXT)};
      window.render = (t) => {
        const f = document.getElementById('f'), b = document.getElementById('b'), r = document.getElementById('r');
        const n = Math.max(0, Math.min(URL_TEXT.length, Math.floor((t - 0.3) * 40)));
        f.className = 'field' + (n ? ' typed' : '');
        f.innerHTML = n ? URL_TEXT.slice(0, n) + (t < 1.9 && Math.floor(t * 2) % 2 === 0 ? '<span class="caret"></span>' : '') : '<span style="color:#9aa0b4">Paste a long URL here…</span>';
        const pressed = t >= 2.0 && t < 2.2;
        b.style.background = pressed ? '#e6e8f2' : t >= 2.2 && t < 2.5 ? '#f3f4f9' : '#fff';
        b.textContent = t >= 2.2 && t < 2.5 ? 'Shortening…' : 'Shorten';
        r.style.visibility = t >= 2.5 ? 'visible' : 'hidden';
      };
    </script>`);
}

/** Writes design/landing.png and media/flow.mp4 into `dir` (a project root). Needs a Playwright `chromium` and ffmpeg. */
export async function makeAssets(chromium, dir) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    fs.mkdirSync(path.join(dir, 'design'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    const img = await browser.newPage({ viewport: { width: 800, height: 540 }, deviceScaleFactor: 1 });
    await img.setContent(landingHtml());
    await img.screenshot({ path: path.join(dir, 'design/landing.png') });
    await img.close();

    const fps = 20, secs = 6;
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-flow-'));
    const vp = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
    await vp.setContent(flowHtml());
    for (let i = 0; i < fps * secs; i++) {
      await vp.evaluate((t) => window.render(t), i / fps);
      await vp.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`) });
    }
    await vp.close();
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-framerate', String(fps), '-i', path.join(frames, 'f%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', path.join(dir, 'media/flow.mp4')]);
    fs.rmSync(frames, { recursive: true, force: true });
  } finally {
    await browser.close();
  }
}
