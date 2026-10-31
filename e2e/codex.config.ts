import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
import { fileURLToPath } from 'node:url';
import { loggedIn } from './auth.ts';
export default defineConfig({ ...base, testMatch: 'codex.spec.ts', projects: [{ name: 'codex', use: { baseURL: 'http://127.0.0.1:4795', storageState: loggedIn('codex', 4795) } }], webServer: [{ command: 'node e2e/codex-serve.mjs', cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:4795/', reuseExistingServer: false, gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } }] });
