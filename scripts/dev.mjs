// `npm run dev`: server (4780) + Vite (5173) on their OWN state dir, so dev never touches the working ~/.nota-bene (R-M5-2).
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

async function main() {
  const { concurrently } = await import('concurrently');
  const env = devEnv(process.env, os.homedir());
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
