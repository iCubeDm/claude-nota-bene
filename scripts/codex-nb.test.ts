import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { parseInvocation, launchArgs, publicOutput } from '../codex/skills/nb/open.mjs';
it('binds the invoking vendor, supports CLI/Desktop and never guesses a fork source', () => {
  expect(launchArgs(parseInvocation(['new', '--host', 'desktop'], {}))).toEqual(['--agent', 'codex', '--detach', '--new']);
  expect(launchArgs(parseInvocation([], {}))).toEqual(['--agent', 'codex', '--detach']);
  const id = '12345678-0000-4000-8000-000000000000';
  expect(launchArgs(parseInvocation(['fork', '--host', 'cli'], { CODEX_THREAD_ID: id }))).toEqual(['--agent', 'codex', '--resume', id, '--fork']);
  expect(() => parseInvocation(['fork'], {})).toThrow(/source thread/i);
  expect(() => parseInvocation(['bad'], {})).toThrow();
});
it('never prints browser credentials to the calling agent', () => {
  expect(publicOutput('opened http://127.0.0.1:4790/#t=abcdef123456\n')).toBe('opened http://127.0.0.1:4790/\n');
});
it('passes paths with spaces as single arguments and sanitizes launcher output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-codex skill-'));
  const fake = path.join(dir, 'launcher.mjs');
  fs.writeFileSync(fake, 'console.log(JSON.stringify(process.argv.slice(2))); console.log("opened http://127.0.0.1:4790/#t=abcdef123456");');
  try {
    const p = spawnSync(process.execPath, [path.resolve('codex/skills/nb/open.mjs'), 'new', '--dir', dir], { env: { ...process.env, NOTA_BENE_BIN: fake }, encoding: 'utf8' });
    expect(p.status).toBe(0); expect(p.stdout).toContain(JSON.stringify(dir)); expect(p.stdout).not.toContain('abcdef123456'); expect(p.stdout).toContain('"--agent","codex"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it('the installed symlink entry point executes rather than silently exiting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-link-'));
  fs.symlinkSync(path.resolve('codex/skills/nb/open.mjs'), path.join(dir, 'open.mjs'));
  try {
    const r = spawnSync(process.execPath, [path.join(dir, 'open.mjs'), 'fork'], { env: { ...process.env, CODEX_THREAD_ID: '' }, encoding: 'utf8' });
    expect(r.status).toBe(1); expect(r.stderr).toContain('source thread');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
