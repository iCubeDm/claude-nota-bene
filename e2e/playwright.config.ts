import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { loggedIn } from './auth.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

// Build the web app once, before the servers start (the env flag stops workers re-running it).
if (!process.env.NB_E2E_BUILT) {
  execFileSync('npm', ['run', 'build', '-w', 'web'], { cwd: root, stdio: 'inherit' });
  process.env.NB_E2E_BUILT = '1';
}

// ffmpeg generates the media fixtures. Detected once here; the env marker reaches serve.mjs (it skips the media) and
// the spec workers (media tests skip with a message). NB_E2E_FFMPEG=0 forces the no-ffmpeg path.
if (process.env.NB_E2E_FFMPEG === undefined) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    process.env.NB_E2E_FFMPEG = '1';
  } catch {
    process.env.NB_E2E_FFMPEG = '0';
    console.warn('e2e: ffmpeg not found on PATH, the media tests are skipped');
  }
}

const fixtures = [
  { name: 'chat', port: 4791 },
  { name: 'slow', port: 4792 },
  { name: 'ask', port: 4793 },
  // all of 4791-4793 are taken, so files takes 4794 (free: 4777-4781 are live windows, 4790 is the manual smoke)
  { name: 'files', port: 4794 },
  // 4795: session and agent controls (M4-16)
  { name: 'controls', port: 4795 },
];

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: { channel: 'chrome', headless: true, locale: 'en-US' },
  // Each project runs only tests whose title carries its @tag (@chat / @slow / @ask / @files / @controls).
  // A test without a tag runs nowhere, so chat.spec.ts must tag every test.
  projects: fixtures.map((f) => ({
    name: f.name,
    grep: new RegExp(`@${f.name}\\b`),
    use: { baseURL: `http://127.0.0.1:${f.port}`, storageState: loggedIn(f.name, f.port) }, // the page's login cookie; auth.spec.ts covers the login itself
  })),
  webServer: fixtures.map((f) => ({
    command: `node e2e/serve.mjs ${f.name} ${f.port}`,
    cwd: root,
    url: `http://127.0.0.1:${f.port}/`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5000 },
    timeout: 30_000,
  })),
});
