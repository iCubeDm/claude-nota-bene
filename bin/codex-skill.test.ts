import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { proofFor } from '../server/src/auth.ts';

it('Desktop skill survives its calling shell, reuses only its vendor window and explicit Stop retires it', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-desktop-'));
  const project = path.join(temp, 'project with spaces'), state = path.join(temp, 'state'), scoped = path.join(state, 'providers/codex');
  fs.mkdirSync(project); fs.mkdirSync(scoped, { recursive: true });
  fs.writeFileSync(path.join(scoped, 'control-token'), 'c'.repeat(64), { mode: 0o600 });
  const wrapper = path.join(temp, 'launch.mjs');
  fs.writeFileSync(wrapper, `import { spawnSync } from 'node:child_process'; const r = spawnSync(process.execPath, [${JSON.stringify(path.resolve('bin/nota-bene.mjs'))}, ...process.argv.slice(2), '--no-open'], { encoding: 'utf8' }); process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);`);
  const env = { ...process.env, NOTA_BENE_BIN: wrapper, NOTA_BENE_HOME: state, NOTA_BENE_PORT_RANGE: '4794-4794', NOTA_BENE_CODEX: path.resolve('server/test/fixtures/codex-app-server.mjs'), NB_CODEX_FIXTURE_CWD: project, NB_CODEX_FIXTURE_STATE: path.join(temp, 'turns.json') };
  delete env.NOTA_BENE_LAUNCHER_PID; delete env.NOTA_BENE_SUPERVISED;
  const run = () => spawnSync(process.execPath, [path.resolve('codex/skills/nb/open.mjs'), '--dir', project], { env, encoding: 'utf8', timeout: 25000 });
  let pid: number | undefined;
  try {
    const first = run(); expect(first.stderr).toBe(''); expect(first.status).toBe(0); expect(first.stdout).toContain('opened http://127.0.0.1:4794'); expect(first.stdout).not.toContain('#t=');
    const windowFile = path.join(scoped, 'windows', '4794.json');
    pid = JSON.parse(fs.readFileSync(windowFile, 'utf8')).pid; expect(() => process.kill(pid!, 0)).not.toThrow();
    const token = fs.readFileSync(path.join(scoped, 'token'), 'utf8').trim();
    const challenge = 'a'.repeat(64);
    const response = await (await fetch(`http://127.0.0.1:4794/hello?c=${challenge}`)).json();
    expect(response.proof).toBe(proofFor(token, 4794, response.n, challenge));
    const second = run(); expect(second.status).toBe(0); expect(second.stdout).toContain('already-open');
    expect(JSON.parse(fs.readFileSync(windowFile, 'utf8')).pid).toBe(pid);
    expect(fs.existsSync(path.join(state, 'windows'))).toBe(false);
    expect((await fetch('http://127.0.0.1:4794/control/stop', { method: 'POST', headers: { 'x-nota-bene-control': 'c'.repeat(64) } })).ok).toBe(true);
    await expect.poll(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, { timeout: 6000 }).toBe(true);
  } finally {
    { try { await fetch('http://127.0.0.1:4794/control/stop', { method: 'POST', headers: { 'x-nota-bene-control': 'c'.repeat(64) }, signal: AbortSignal.timeout(1000) }); } catch {} }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 35000);
