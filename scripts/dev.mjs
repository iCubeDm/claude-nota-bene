// `npm run dev`: server (4780) + Vite (5173) on their OWN state dir, so dev never touches the working ~/.nota-bene (R-M5-2).
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The env for the dev processes: an existing NOTA_BENE_HOME wins; empty counts as unset. */
export function devEnv(env, home) {
  return {
    ...env,
    NOTA_BENE_HOME: env.NOTA_BENE_HOME || path.join(home, '.nota-bene-dev'),
  };
}

/**
 * One launch nonce for the whole `npm run dev` session (server/src/auth.ts): `node --watch` restarts the server on every edit,
 * and a fresh nonce each time would log the page out. Dev only; a production launcher keeps its nonce across exit 75 only.
 */
export const devNonce = () => randomBytes(16).toString('hex');

async function main() {
  // the page is behind the access token: this opens http://localhost:5173 logged in (the token never goes to a log or argv)
  console.log('Nota Bene dev: once Vite is up, `npm run dev:open` opens it logged in (the dev state dir has its own token).');
  const { concurrently } = await import('concurrently');
  const env = { ...devEnv(process.env, os.homedir()), NOTA_BENE_NONCE: devNonce() };
  const { result } = concurrently(
    [
      { command: 'node --watch server/src/main.ts --port 4780 --allow-origin http://localhost:5173', name: 'server', env },
      { command: 'vite web', name: 'web', env },
    ],
    { killOthersOn: ['failure'], cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') },
  );
  await result.then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
