import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The page must work offline and must not tell any third party that it was opened: a real build of the web app, then its
// index.html and every CSS file are searched for a reference to another host. (The fonts are bundled: web/src/fonts.css.)
const WEB = fileURLToPath(new URL('../web', import.meta.url));
let out: string;
beforeAll(() => {
  out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-offline-')));
  const r = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: WEB, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`vite build failed: ${r.stdout}${r.stderr}`);
}, 120_000);
afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

it('index.html loads nothing from another host (no http(s):// or protocol-relative URL)', () => {
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  expect(html).not.toMatch(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
  expect(html).not.toMatch(/preconnect|dns-prefetch|googleapis|gstatic/i);
});

it('no built CSS fetches from another host (@import, url(), src)', () => {
  const css = files(out).filter((f) => f.endsWith('.css'));
  expect(css.length).toBeGreaterThan(0);
  for (const f of css) {
    const text = fs.readFileSync(f, 'utf8');
    expect([f, text.match(/@import\s*(?:url\()?\s*["']?(?:https?:)?\/\/[^)"';\s]+/gi)]).toEqual([f, null]);
    expect([f, text.match(/url\(\s*["']?(?:https?:)?\/\/[^)"']+/gi)]).toEqual([f, null]);
  }
});

it('Inter 400/500/600 and Geist Mono 400/500 are in the build, latin and cyrillic, as local woff2 files', () => {
  const woff = files(out).filter((f) => f.endsWith('.woff2')).map((f) => path.basename(f));
  for (const [name, weights] of [['inter', [400, 500, 600]], ['geist-mono', [400, 500]]] as const) {
    for (const w of weights) for (const sub of ['latin', 'cyrillic']) {
      expect(woff.some((n) => n.startsWith(`${name}-${sub}-${w}-normal`))).toBe(true);
    }
  }
  expect(woff).toHaveLength(10); // nothing else (other subsets, weights, italics) is bundled
  const css = files(out).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const fam of ['Inter', 'Geist Mono']) expect(css).toMatch(new RegExp(`@font-face\\{font-family:["']?${fam}["']?`));
});
