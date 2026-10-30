// `npm run dev:open`: opens the Vite dev page (http://localhost:5173) logged in to the dev server. The dev state dir has its own
// access token; the launcher writes a mode-600 page that redirects to the URL with the token in the fragment, so the token is never
// in argv or in a log (bin/nota-bene.mjs --front).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devEnv } from './dev.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nota-bene.mjs');
const r = spawnSync(process.execPath, [bin, '--front', 'http://localhost:5173'], { env: devEnv(process.env, os.homedir()), stdio: 'inherit' });
process.exit(r.status ?? 1);
