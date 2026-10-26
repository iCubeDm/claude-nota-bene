import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TreeEntry } from '@nota-bene/shared';

export const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);
// the tree shows build output and the media comments' `.nota-bene` folder; the file walk (the prototype's SKIP_DIRS,
// so @ completion) does not: frame.jpg/layer.png of every comment would crowd out the project's own files
const SKIP_DIRS = new Set([...HIDDEN, 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache', '.nota-bene']);
const CAP = 20_000;
const TTL = 10_000;

/**
 * Resolve a project-relative path (already URL-decoded once by the caller) to an absolute one.
 * null = outside the root: lexically (`..`, absolute) or through a symlink (the realpath of the deepest
 * existing ancestor must stay inside realpath(root)). The tail may not exist yet.
 */
export function resolveInRoot(root: string, rel: string): string | null {
  if (rel.includes('\0') || path.isAbsolute(rel)) return null;
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  // native realpath on both sides: a case difference between the argument and the disk must not refuse valid paths.
  // Accepted gap: a symlink swapped between this check and the open (TOCTOU) — fine for a localhost tool.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(rootAbs);
  } catch {
    return null;
  }
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return real === realRoot || real.startsWith(realRoot + path.sep) ? abs : null;
    } catch {
      try {
        fs.lstatSync(cur);
        return null; // exists but cannot be resolved: a dangling symlink, do not trust it
      } catch {
        const up = path.dirname(cur);
        if (up === cur) return null;
        cur = up;
      }
    }
  }
}

/** Lists a folder for /tree. Symlinks that do not resolve inside `root` are hidden, like in listFiles (/file refuses them). */
export async function listDir(abs: string, root: string): Promise<TreeEntry[]> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const ents = await fs.promises.readdir(abs, { withFileTypes: true });
  const out: TreeEntry[] = [];
  for (const e of ents) {
    if (HIDDEN.has(e.name)) continue;
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        const full = path.join(abs, e.name);
        const real = await fs.promises.realpath(full);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
        dir = (await fs.promises.stat(real)).isDirectory();
      } catch {
        continue; // dangling: /file would refuse it too
      }
    }
    out.push({ name: e.name, dir });
  }
  return sortEntries(out);
}

/** Folders first, then names in `localeCompare(…, 'ru', { numeric: true })` order (the prototype's tree order). */
export const sortEntries = (out: TreeEntry[]): TreeEntry[] =>
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ru', { numeric: true }));

const cache = new Map<string, { at: number; files: Promise<string[]>; refreshing: boolean }>();

// a symlink counts only when it points at a file inside the root
async function linkedFileInRoot(abs: string, realRoot: string): Promise<boolean> {
  try {
    const real = await fs.promises.realpath(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return false;
    return (await fs.promises.stat(real)).isFile();
  } catch {
    return false;
  }
}

async function walk(root: string): Promise<string[]> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  const queue = ['']; // breadth-first, so the cap cuts the deepest files first
  while (queue.length && out.length < CAP) {
    const rel = queue.shift()!;
    let ents: fs.Dirent[];
    try {
      ents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) queue.push(r); // symlinked dirs are not followed
      else if (e.isFile() || (e.isSymbolicLink() && (await linkedFileInRoot(path.join(root, r), realRoot)))) {
        out.push(r);
        if (out.length >= CAP) break;
      }
    }
  }
  return out;
}

const GIT_TIMEOUT = 5_000;

/**
 * The environment of every git call: pathspecs are literal (a file named `:(top)x` is just a name), no optional locks
 * (we only read, while agents may be committing), and an inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (a server
 * started from a git hook, say) can never point git at another repo.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, env: gitEnv(), maxBuffer: 64 << 20, timeout: GIT_TIMEOUT },
      (err, out) => {
        if (err || !out) return resolve(null); // not a repo, no git, timeout, or an empty repo: walk instead
        resolve(out.split('\0').filter(Boolean));
      },
    );
  });
}

// git lists tracked-but-deleted files, submodules and links out of the root: keep only real files inside it.
// Build output is dropped first (an untracked node_modules is listed by git without a .gitignore), then the
// rest is sorted shallow-first, so that the cap cuts the deepest files, like the walk does.
async function existingFiles(root: string, rels: string[]): Promise<string[]> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return [];
  }
  const cand = rels.filter((r) => !r.split('/').some((seg) => SKIP_DIRS.has(seg)));
  const keep: boolean[] = new Array(cand.length).fill(false);
  for (let i = 0; i < cand.length; i += 256) {
    await Promise.all(
      cand.slice(i, i + 256).map(async (r, k) => {
        const abs = path.join(root, r);
        try {
          const st = await fs.promises.lstat(abs);
          keep[i + k] = st.isFile() || (st.isSymbolicLink() && (await linkedFileInRoot(abs, realRoot)));
        } catch {
          // deleted
        }
      }),
    );
  }
  const depth = (r: string) => r.split('/').length;
  return cand
    .filter((_, i) => keep[i])
    .sort((x, y) => depth(x) - depth(y)) // stable
    .slice(0, CAP);
}

// folders as `dir/` entries (the prototype's way, so that an @ pick of a folder works), folders first
export function withDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  return [...dirs, ...files];
}

async function collect(root: string): Promise<string[]> {
  const git = await gitFiles(root);
  const files = git ? await existingFiles(root, git) : [];
  return withDirs(files.length ? files : await walk(root));
}

/**
 * Project files (and `dir/` entries), relative and '/'-separated; capped at 20 000 files, cached for 10 s.
 * After the TTL the stale list is served at once and refreshed in the background; only the first call waits.
 */
export function listFiles(root: string): Promise<string[]> {
  const hit = cache.get(root);
  if (hit) {
    if (Date.now() - hit.at >= TTL && !hit.refreshing) {
      hit.refreshing = true;
      collect(root).then(
        (files) => cache.set(root, { at: Date.now(), files: Promise.resolve(files), refreshing: false }),
        () => { hit.refreshing = false; }, // keep serving the stale list
      );
    }
    return hit.files;
  }
  const files = collect(root);
  cache.set(root, { at: Date.now(), files, refreshing: false });
  files.catch(() => cache.delete(root));
  return files;
}
