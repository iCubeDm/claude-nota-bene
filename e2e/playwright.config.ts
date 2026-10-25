import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));

// Build the web app once, before the servers start (the env flag stops workers re-running it).
if (!process.env.NB_E2E_BUILT) {
  execFileSync('npm', ['run', 'build', '-w', 'web'], { cwd: root, stdio: 'inherit' });
  process.env.NB_E2E_BUILT = '1';
}

const fixtures = [
  { name: 'chat', port: 4791 },
  { name: 'slow', port: 4792 },
  { name: 'ask', port: 4793 },
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
  // Each project runs only tests whose title carries its @tag (@chat / @slow / @ask).
  // A test without a tag runs nowhere, so chat.spec.ts must tag every test.
  projects: fixtures.map((f) => ({
    name: f.name,
    grep: new RegExp(`@${f.name}\\b`),
    use: { baseURL: `http://127.0.0.1:${f.port}` },
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
