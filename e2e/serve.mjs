// Starts one fake-agent server with its own temp project dir (seeded from e2e/project/) and NOTA_BENE_HOME; removes both on exit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [fixture, port] = process.argv.slice(2);
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nota-bene-e2e-${fixture}-`));
const project = path.join(tmp, 'project');
const home = path.join(tmp, 'home');
fs.mkdirSync(project);
// e2e/project/ seeds the project with files the file-tab specs open
fs.cpSync(path.join(root, 'e2e/project'), project, { recursive: true });
fs.mkdirSync(home);

const child = spawn(
  process.execPath,
  [path.join(root, 'server/src/main.ts'), project, '--port', port, '--fake', path.join(root, 'server/test/fixtures', `${fixture}.json`)],
  { cwd: root, env: { ...process.env, NOTA_BENE_HOME: home }, stdio: 'inherit' },
);

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
child.on('exit', (code) => finish(code ?? 0));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); finish(0); }, 3000).unref();
  });
}
