#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
export function parseInvocation(argv, env = process.env) {
  const o = { mode: 'last', host: 'desktop', dir: undefined, source: env.CODEX_THREAD_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--host', '--dir', '--source'].includes(a)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
      o[a.slice(2)] = v;
    } else if (['last', 'new', 'fork'].includes(a) && i === 0) o.mode = a;
    else throw new Error('Usage: open.mjs [new|fork] [--host desktop|cli] [--dir PATH] [--source THREAD_ID]');
  }
  if (!['desktop', 'cli'].includes(o.host)) throw new Error('Host must be desktop or cli');
  if (o.mode === 'fork' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.source ?? '')) throw new Error('No valid source thread id for fork. Pass --source or use CODEX_THREAD_ID from the invoking host.');
  return o;
}
export function launchArgs(o) {
  return [...(o.dir ? [o.dir] : []), '--agent', 'codex', ...(o.host === 'desktop' ? ['--detach'] : []), ...(o.mode === 'new' ? ['--new'] : o.mode === 'fork' ? ['--resume', o.source, '--fork'] : [])];
}
export const publicOutput = (text) => text.replace(/#t=[^\s"'<>]*/g, '');

async function main() {
  const o = parseInvocation(process.argv.slice(2));
  if (process.env.NOTA_BENE_SUPERVISED) throw new Error('Already inside Nota Bene; use the session controls in this window.');
  const bundled = fileURLToPath(new URL('../../../bin/nota-bene.mjs', import.meta.url));
  const executable = process.env.NOTA_BENE_BIN ?? (fs.existsSync(bundled) ? bundled : 'nota-bene');
  const args = launchArgs(o);
  if (process.env.NOTA_BENE_FAKE) args.push('--fake', process.env.NOTA_BENE_FAKE);
  const child = executable.endsWith('.mjs') || executable.endsWith('.js')
    ? spawn(process.execPath, [executable, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep partial lines until complete so a token split between chunks cannot escape redaction.
  let reused = false;
  const relay = (stream, output) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i + 1); pending = pending.slice(i + 1);
        if (line.includes('already-open') || line.includes('already open')) reused = true;
        output.write(publicOutput(line));
      }
      if (pending.length > 65536) { pending = ''; child.kill('SIGTERM'); }
    });
    stream.on('end', () => { if (pending) output.write(publicOutput(pending)); });
  };
  relay(child.stdout, process.stdout); relay(child.stderr, process.stderr);
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const code = await new Promise((resolve) => { child.on('error', () => { process.stderr.write('Cannot start Nota Bene. Install nota-bene-ide or set NOTA_BENE_BIN.\n'); resolve(1); }); child.on('exit', (c) => resolve(c ?? 1)); });
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  if (reused && o.mode !== 'last') process.stdout.write(`The existing window was brought forward; ${o.mode} was not applied to its conversation. Use a new window after closing it, or its session controls.\n`);
  process.exitCode = code;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) void main().catch((e) => { process.stderr.write(publicOutput(e.message) + '\n'); process.exitCode = 1; });
