// Starts one fake-agent server with its own temp project dir (seeded from e2e/project/) and NOTA_BENE_HOME; removes both on exit.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
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
// the access token is on (the server default): a known one per fixture, so the config can log its browsers in (e2e/auth.ts)
fs.writeFileSync(path.join(home, 'token'), createHash('sha256').update(`nota-bene e2e ${fixture}`).digest('hex'), { mode: 0o600 });
if (fixture === 'files') seedFiles(project);
// the controls fixture's second session lives in a sibling folder of the project (removed with tmp)
// experimental 3D is off by default; only the files fixture (the 3D specs) turns it on. The controls fixture keeps it off and
// holds a model file, to check that it behaves as any other binary there (e2e/model3d-off.spec.ts)
if (fixture === 'controls') {
  fs.mkdirSync(path.join(project, 'models'));
  fs.copyFileSync(path.join(root, 'e2e/fixtures/project/models/cube.glb'), path.join(project, 'models/cube.glb'));
}
if (fixture === 'controls') {
  fs.mkdirSync(path.join(tmp, 'other'));
  fs.writeFileSync(path.join(tmp, 'other/other.md'), '# Other project\n\nonly in the other folder\n');
}

// A w x h grey PNG, generated (a few KB compressed): M6-04 checks that a large image is fitted to the pane.
function bigPng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; // 8-bit grey
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w + 1) * h, 0x80))), chunk('IEND', Buffer.alloc(0))]);
}

function hasFfmpeg() {
  if (process.env.NB_E2E_FFMPEG !== undefined) return process.env.NB_E2E_FFMPEG === '1';
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Binary and big fixtures are generated, never committed: mp4/mp3 (ffmpeg; the mp4s are noisy and about 3 MB so that a seek really needs a range request), a 1x1 png, a 3 MB log, a symlink out of the project.
function seedFiles(dir) {
  fs.cpSync(path.join(root, 'e2e/fixtures/project'), dir, { recursive: true });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  fs.writeFileSync(path.join(dir, 'docs/pic.png'), Buffer.from(png, 'base64'));
  fs.writeFileSync(path.join(dir, 'docs/big.png'), bigPng(3000, 2000));
  fs.mkdirSync(path.join(dir, 'media'));
  // the config sets NB_E2E_FFMPEG (1/0); run alone, serve.mjs asks ffmpeg itself. Without it the media tests skip
  if (hasFfmpeg()) {
    const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: 'inherit' });
    for (const [name, color] of [['a', 'red'], ['b', 'green'], ['c', 'blue']]) {
      ff('-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=30:r=10,noise=alls=100:allf=t`, '-b:v', '1M', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', path.join(dir, `media/${name}.mp4`));
    }
    ff('-f', 'lavfi', '-i', 'sine=d=3', path.join(dir, 'media/s.mp3'));
    // media comments: a 2:1 image a wide pane letterboxes, and a 4K one for the drawing's lag (solid: a few KB each)
    ff('-f', 'lavfi', '-i', 'color=c=0x3a6ea5:s=1000x500', '-frames:v', '1', path.join(dir, 'media/wide.png'));
    ff('-f', 'lavfi', '-i', 'color=c=0x556b2f:s=3840x2160', '-frames:v', '1', path.join(dir, 'media/4k.png'));
  } else console.warn('e2e/serve.mjs: no ffmpeg, media fixtures skipped');
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(3 * 1024 * 1024));
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'link-out'));
  // M3-16: the project is a git repo with one more worktree, on feature/x, outside the project (removed with tmp)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const wt = path.join(tmp, 'wt-x');
  git('worktree', 'add', '-q', '-b', 'feature/x', wt);
  fs.writeFileSync(path.join(wt, 'only-x.md'), '# Only on feature/x\n\nwritten by another agent\n');
}

const child = spawn(
  process.execPath,
  [path.join(root, 'server/src/main.ts'), project, '--port', port, '--fake', path.join(root, 'server/test/fixtures', `${fixture}.json`)],
  { cwd: root, env: { ...process.env, NOTA_BENE_HOME: home, NOTA_BENE_EXPERIMENTAL_3D: fixture === 'files' ? '1' : '0' }, stdio: 'inherit' },
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
