import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Blender's own app path on macOS, the last place we look. */
export const MAC_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender';
export const EXPORT_SCRIPT = path.join(import.meta.dirname, 'blend', 'export.py');

const isExecutable = (p: string): boolean => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The Blender binary: `NOTA_BENE_BLENDER` when set (it is authoritative: a wrong path means "no Blender", never a
 * silent fall-through to another one), else `blender` on PATH, else the macOS app. null = none.
 */
export function findBlender(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isExecutable): string | null {
  const own = env.NOTA_BENE_BLENDER;
  if (own) return exists(own) ? own : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'blender');
    if (exists(p)) return p;
  }
  return exists(MAC_BLENDER) ? MAC_BLENDER : null;
}

export class BlendError extends Error {
  status: number;
  code: string;
  detail: string;
  constructor(status: number, code: string, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export type BlendOptions = {
  /** `<NOTA_BENE_HOME>`: the cache lives in `<stateDir>/cache/blend` */
  stateDir: () => string;
  blender?: () => string | null;
  timeoutMs?: number;
  /** after SIGTERM, how long before SIGKILL */
  graceMs?: number;
};

export type Converted = { glb: string; hash: string };
export type BlendInput = { file: string } | { bytes: Buffer };

const TAIL_BYTES = 4096;
const TAIL_LINES = 12;

// the child gets no secrets from our environment (API keys, tokens): only what a program needs to start
const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
};

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * .blend → GLB with the local Blender. One conversion at a time; identical requests in flight share one; results are
 * cached by the content hash and the Blender version. The .blend may come from the agent, so Blender always runs
 * `-b --disable-autoexec --factory-startup` through spawn with an argument array (no shell), and the paths reach the
 * fixed `blend/export.py` as arguments, never inside Python source.
 */
export class BlendConverter {
  private readonly o: Required<Omit<BlendOptions, 'blender'>> & { blender: () => string | null };
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<Converted>>();
  private readonly versions = new Map<string, Promise<string>>();

  constructor(o: BlendOptions) {
    this.o = { timeoutMs: 120_000, graceMs: 3000, blender: () => findBlender(), ...o };
  }

  available(): boolean {
    return this.o.blender() !== null;
  }

  private dir(): string {
    const d = path.join(this.o.stateDir(), 'cache', 'blend');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private version(bin: string): Promise<string> {
    let v = this.versions.get(bin);
    if (!v) {
      v = new Promise<string>((resolve, reject) => {
        execFile(bin, ['--version'], { timeout: 15_000, env: childEnv() }, (err, stdout) => {
          const m = /Blender\s+(\d+(?:\.\d+)*)/i.exec(String(stdout));
          if (err || !m) reject(new BlendError(501, 'no-blender', 'could not run Blender --version'));
          else resolve(m[1]!);
        });
      });
      this.versions.set(bin, v);
      v.catch(() => this.versions.delete(bin));
    }
    return v;
  }

  async convert(input: BlendInput): Promise<Converted> {
    const bin = this.o.blender();
    if (!bin) throw new BlendError(501, 'no-blender');
    const version = await this.version(bin);
    const hash = 'file' in input ? await sha256File(input.file) : crypto.createHash('sha256').update(input.bytes).digest('hex');
    const dir = this.dir();
    const hit = path.join(dir, `${hash}-${version}.glb`);
    if (fs.existsSync(hit)) return { glb: hit, hash };
    const key = `${hash}-${version}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.enqueue(() => this.run(bin, version, input, hash, dir)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async run(bin: string, version: string, input: BlendInput, hash: string, dir: string): Promise<Converted> {
    const hit = path.join(dir, `${hash}-${version}.glb`);
    if (fs.existsSync(hit)) return { glb: hit, hash }; // an earlier job of the queue made it
    const work = fs.mkdtempSync(path.join(dir, 'work-'));
    try {
      // Blender reads our copy, never the project file: the bytes that were hashed are the bytes converted
      const blend = path.join(work, 'in.blend');
      if ('file' in input) fs.copyFileSync(input.file, blend);
      else fs.writeFileSync(blend, input.bytes);
      const out = path.join(work, 'out.glb');
      // the file may have changed between the hash and the copy: the name follows the bytes Blender actually gets
      if ('file' in input) hash = await sha256File(blend);
      const done = path.join(dir, `${hash}-${version}.glb`);
      await this.spawnBlender(bin, blend, out, work);
      let st: fs.Stats | null = null;
      try { st = fs.statSync(out); } catch { /* no output */ }
      if (!st?.isFile() || st.size === 0) throw new BlendError(422, 'export-failed', 'Blender produced no output');
      fs.renameSync(out, done);
      return { glb: done, hash };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  private spawnBlender(bin: string, blend: string, out: string, cwd: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = ['-b', '--disable-autoexec', '--factory-startup', blend, '--python-exit-code', '1', '--python', EXPORT_SCRIPT, '--', out];
      let child;
      try {
        child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch (e) {
        return reject(new BlendError(501, 'no-blender', e instanceof Error ? e.message : String(e)));
      }
      let tail = '';
      const take = (d: Buffer) => { tail = (tail + d.toString('utf8')).slice(-TAIL_BYTES); };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      const lastLines = () => tail.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-TAIL_LINES).join('\n');
      let timedOut = false;
      let killer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killer = setTimeout(() => child.kill('SIGKILL'), this.o.graceMs);
      }, this.o.timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        clearTimeout(killer);
        reject(new BlendError(501, 'no-blender', e.message));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killer);
        if (timedOut) reject(new BlendError(504, 'timeout', `Blender did not finish in ${Math.round(this.o.timeoutMs / 1000)} s and was stopped\n${lastLines()}`.trim()));
        else if (code !== 0) reject(new BlendError(422, 'export-failed', lastLines() || `Blender exited with ${signal ?? code}`));
        else resolve();
      });
    });
  }
}
