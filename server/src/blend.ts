import { spawn, execFile, type ChildProcess } from 'node:child_process';
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
  /** `outside-refs`: what the .blend references outside the project */
  paths?: string[];
  constructor(status: number, code: string, detail = '', paths?: string[]) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.paths = paths;
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

/** `transient`: not in the cache (the file changed while it was converted): the caller removes `glb` after sending it. */
export type Converted = { glb: string; hash: string; transient?: boolean };
/**
 * `file`: a project file, opened by Blender where it lies (so `//tex.png` finds its neighbours); `base` is the root it
 * was resolved in: the only place the .blend may reference files in. `bytes`: a branch blob, written to a temp file;
 * it may reference nothing but its own packed data.
 */
export type BlendInput = { file: string; base: string } | { bytes: Buffer };

const TAIL_BYTES = 16384;
const TAIL_LINES = 12;

// the child gets no secrets from our environment (API keys, tokens): only what a program needs to start
const childEnv = (): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
};

const memo = new Map<string, string>();
/** sha256 of a file; the same (path, size, mtime, inode) is not read again unless `fresh`. */
async function sha256Of(file: string, fresh = false): Promise<string> {
  const st = await fs.promises.stat(file);
  const key = `${file}\0${st.size}\0${st.mtimeMs}\0${st.ino}`;
  const known = fresh ? undefined : memo.get(key);
  if (known) return known;
  const h = await sha256File(file);
  if (memo.size > 500) memo.clear();
  memo.set(key, h);
  return h;
}

/** Only a missing binary is "no Blender"; any other failure to start is reported as what it is. */
function spawnError(e: unknown): BlendError {
  const msg = e instanceof Error ? e.message : String(e);
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? new BlendError(501, 'no-blender', msg) : new BlendError(500, 'spawn-failed', msg);
}

/** export.py ends a refusal with one `NB-REFUSED <json array>` line. */
function refusedPaths(tail: string): string[] | null {
  const line = tail.split('\n').reverse().find((l) => l.startsWith('NB-REFUSED '));
  if (!line) return null;
  try {
    const v: unknown = JSON.parse(line.slice('NB-REFUSED '.length));
    return Array.isArray(v) ? v.map(String).slice(0, 10) : null;
  } catch {
    return null;
  }
}

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

  private child: ChildProcess | null = null;
  private readonly works = new Set<string>();
  private disposed = false;
  private swept = false;
  private readonly onExit = () => { this.child?.kill('SIGKILL'); };

  constructor(o: BlendOptions) {
    this.o = { timeoutMs: 120_000, graceMs: 3000, blender: () => findBlender(), ...o };
  }

  available(): boolean {
    return this.o.blender() !== null;
  }

  /** Kills a running Blender (SIGKILL) and removes its work dir; the server calls it on close. */
  dispose(): void {
    this.disposed = true;
    this.child?.kill('SIGKILL');
    for (const w of this.works) fs.rmSync(w, { recursive: true, force: true });
    this.works.clear();
  }

  private dir(): string {
    const d = path.join(this.o.stateDir(), 'cache', 'blend');
    fs.mkdirSync(d, { recursive: true });
    if (!this.swept) {
      this.swept = true;
      // leftovers of a server that was killed mid-conversion
      for (const n of fs.readdirSync(d)) {
        if (!/^(work-|tmp-)/.test(n)) continue;
        try {
          if (Date.now() - fs.statSync(path.join(d, n)).mtimeMs > 3600_000) fs.rmSync(path.join(d, n), { recursive: true, force: true });
        } catch { /* gone already */ }
      }
    }
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
    if (this.disposed) throw new BlendError(503, 'closing', 'the server is stopping');
    const bin = this.o.blender();
    if (!bin) throw new BlendError(501, 'no-blender');
    const version = await this.version(bin);
    const hash = 'file' in input ? await sha256Of(input.file) : crypto.createHash('sha256').update(input.bytes).digest('hex');
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
    if (this.disposed) throw new BlendError(503, 'closing', 'the server is stopping');
    const work = await fs.promises.mkdtemp(path.join(dir, 'work-'));
    this.works.add(work);
    try {
      const out = path.join(work, 'out.glb');
      let blend: string;
      let bases: string[];
      if ('file' in input) {
        blend = input.file; // opened in place: relative textures and libraries (`//tex.png`) resolve next to it
        bases = [await fs.promises.realpath(input.base)];
      } else {
        blend = path.join(work, 'in.blend');
        await fs.promises.writeFile(blend, input.bytes);
        bases = []; // a blob has no neighbours: only its packed data is allowed
      }
      await this.spawnBlender(bin, blend, out, work, bases);
      let st: fs.Stats | null = null;
      try { st = await fs.promises.stat(out); } catch { /* no output */ }
      if (!st?.isFile() || st.size === 0) throw new BlendError(422, 'export-failed', 'Blender produced no output');
      // the file may have changed while Blender read it: then the result is served but not cached under the old hash
      if ('file' in input && (await sha256Of(input.file, true)) !== hash) {
        const tmp = path.join(dir, `tmp-${crypto.randomBytes(8).toString('hex')}.glb`);
        await fs.promises.rename(out, tmp);
        return { glb: tmp, hash: crypto.randomBytes(16).toString('hex'), transient: true };
      }
      await fs.promises.rename(out, hit);
      return { glb: hit, hash };
    } finally {
      this.works.delete(work);
      await fs.promises.rm(work, { recursive: true, force: true });
    }
  }

  private spawnBlender(bin: string, blend: string, out: string, cwd: string, bases: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = ['-b', '--disable-autoexec', '--factory-startup', '--offline-mode', '-noaudio', blend, '--python-exit-code', '1', '--python', EXPORT_SCRIPT, '--', out, ...bases];
      let child;
      try {
        child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch (e) {
        return reject(spawnError(e));
      }
      this.child = child;
      process.on('exit', this.onExit);
      const release = () => { if (this.child === child) this.child = null; process.off('exit', this.onExit); };
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
        release();
        reject(spawnError(e));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killer);
        release();
        const refused = refusedPaths(tail);
        if (timedOut) reject(new BlendError(504, 'timeout', `Blender did not finish in ${Math.round(this.o.timeoutMs / 1000)} s and was stopped\n${lastLines()}`.trim()));
        else if (this.disposed) reject(new BlendError(503, 'closing', 'the server is stopping'));
        else if (refused) reject(new BlendError(422, 'outside-refs', 'the .blend references files outside the project', refused));
        else if (code !== 0) reject(new BlendError(422, 'export-failed', lastLines() || `Blender exited with ${signal ?? code}`));
        else resolve();
      });
    });
  }
}
