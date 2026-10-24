import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeBackend } from './agent/fake.ts';
import { sdkBackend } from './agent/sdk.ts';
import { startServer } from './server.ts';
import { lastSession } from './state.ts';

const USAGE =
  'Usage: node server/src/main.ts [dir] [--port N] [--resume ID] [--continue] [--fake script.json] [--allow-origin URL]';

export function parseArgs(
  argv: string[],
  cwd: string,
): { dir: string; port: number; resume?: string; continue: boolean; fake?: string; allowOrigins: string[] } {
  let dirArg: string | undefined;
  let port = 4777;
  let resume: string | undefined;
  let cont = false;
  let fake: string | undefined;
  const allowOrigins: string[] = [];
  const value = (i: number): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${USAGE}\nMissing value for ${argv[i - 1]}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port') {
      const v = value(++i);
      if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`${USAGE}\nInvalid port: ${v}`);
      port = Number(v);
    } else if (a === '--resume') resume = value(++i);
    else if (a === '--continue') cont = true;
    else if (a === '--fake') fake = value(++i);
    else if (a === '--allow-origin') allowOrigins.push(value(++i));
    else if (a.startsWith('--')) throw new Error(`${USAGE}\nUnknown option: ${a}`);
    else if (dirArg === undefined) dirArg = a;
    else throw new Error(`${USAGE}\nUnexpected argument: ${a}`);
  }
  const dir = fs.realpathSync(path.resolve(cwd, dirArg ?? '.'));
  if (cont) resume = lastSession(dir);
  return { dir, port, resume, continue: cont, fake, allowOrigins };
}

// `npm start -- ../proj` runs with cwd = package root; INIT_CWD is where npm was invoked.
export function invocationCwd(env: NodeJS.ProcessEnv, cwd: string): string {
  return env.INIT_CWD || cwd;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2), invocationCwd(process.env, process.cwd()));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const backend = args.fake
    ? fakeBackend(JSON.parse(fs.readFileSync(path.resolve(args.fake), 'utf8')))
    : sdkBackend();
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const { url, close } = await startServer({
    cwd: args.dir,
    port: args.port,
    backend,
    resume: args.resume,
    webDist,
    allowedOrigins: args.allowOrigins,
  });
  console.log(`Nota Bene: ${url}  project: ${args.dir}`);
  const stop = () => {
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
