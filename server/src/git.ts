import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Source, TreeEntry } from '@nota-bene/shared';
import { gitEnv, HIDDEN, listDir, resolveInRoot, sortEntries, withDirs } from './files.ts';

export type { Source };

/**
 * Read-only views of other worktrees and branches (M3-16). The window's own checkout is never switched: a live window
 * may run from it. Every git call is execFile (never a shell), refs come only from git's own listings, and paths go
 * after `--` or inside `<ref>:<path>` once they are validated as project-relative.
 */

const TIMEOUT = 5_000;
const TTL = 5_000;
/** A branch blob above `blobMax` is not served (413, for GET and HEAD alike). Mutable for tests only. */
export const limits = { blobMax: 50 * 1024 * 1024 };
const FILES_CAP = 20_000;

/** status: what the route answers (403 outside the root, 404 missing, 413 too large). */
export class SourceError extends Error {
  readonly status: 403 | 404 | 413;
  constructor(status: 403 | 404 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

function git(cwd: string, args: string[], maxBuffer = 16 << 20, timeout = TIMEOUT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv(), timeout, maxBuffer, encoding: 'buffer' }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}
const gitText = async (cwd: string, args: string[]) => (await git(cwd, args)).toString('utf8');

async function realOr(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** top: the repo's top level ('' when not a repo); prefix: root's path inside it, '' or ending in '/'. */
type Repo = { top: string; prefix: string; sources: Source[] };

/** The ref of a detached worktree, for comments and the chip. `(` and a space fail check-ref-format: never a branch name. */
const detachedRef = (dir: string) => `(detached) ${path.basename(dir)}`;

/**
 * Stable ids (they are persisted in tabs and tree state): 'here'; `ref:<branch>` for every other local branch;
 * `dir:<sha1(realpath) 12 hex>` for a detached worktree. `kind`/`dir` say how a source is served RIGHT NOW: a branch
 * checked out in a live worktree is served from that folder (live, Range, reloads), otherwise from its blobs. So a
 * prunable worktree (its folder deleted) does not hide its branch: the branch falls back to blobs.
 */
async function scan(root: string): Promise<Repo> {
  const dir = path.resolve(root);
  const realDir = await realOr(dir);
  const here: Source = { id: 'here', kind: 'checkout', label: path.basename(dir), ref: '', dir: realDir, ...(realDir !== dir ? { alias: dir } : {}) };
  let top: string;
  let prefix: string;
  try {
    const out = (await gitText(dir, ['rev-parse', '--show-toplevel', '--show-prefix'])).split('\n');
    top = out[0];
    prefix = out[1] ?? '';
    if (!top) throw new Error('no top level');
  } catch {
    return { top: '', prefix: '', sources: [here] }; // not a repo, or no git
  }
  const realTop = await realOr(top);
  const live = new Map<string, { dir: string; alias?: string }>(); // branch -> serving dir of its live worktree
  const worktrees: Source[] = [];
  try {
    for (const block of (await gitText(top, ['worktree', 'list', '--porcelain'])).split('\n\n')) {
      const lines = block.split('\n');
      const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!wt || lines.includes('bare')) continue;
      const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length);
      const real = await realOr(wt);
      if (real === realTop) {
        if (branch) here.ref = here.label = branch;
        continue;
      }
      if (!fs.existsSync(real)) continue; // prunable: its branch (if any) is served from blobs below
      const serve = path.join(real, prefix).replace(/\/$/, '');
      const given = path.join(wt, prefix).replace(/\/$/, '');
      const where = { dir: serve, ...(given !== serve ? { alias: given } : {}) };
      if (branch) live.set(branch, where);
      else {
        const ref = detachedRef(real);
        const id = `dir:${createHash('sha1').update(real).digest('hex').slice(0, 12)}`;
        worktrees.push({ id, kind: 'worktree', label: ref, ref, ...where });
      }
    }
  } catch {
    // an old git without `worktree`: branches only
  }
  const branches: Source[] = [];
  try {
    for (const r of (await gitText(top, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).split('\n')) {
      if (!r.startsWith('refs/heads/')) continue;
      const name = r.slice('refs/heads/'.length);
      if (name === here.ref) continue; // this checkout is 'here'
      const d = live.get(name);
      const s: Source = d ? { id: `ref:${name}`, kind: 'worktree', label: name, ref: name, ...d } : { id: `ref:${name}`, kind: 'branch', label: name, ref: name };
      (d ? worktrees : branches).push(s);
    }
  } catch {
    // an empty repo has no refs
  }
  return { top, prefix, sources: [here, ...worktrees, ...branches] };
}

const cache = new Map<string, { at: number; p: Promise<Repo> }>();
/** Test hook. */
export const clearSourceCache = () => cache.clear();

function repo(root: string): Promise<Repo> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = scan(root);
  cache.set(root, { at: Date.now(), p });
  return p;
}

/** 'here', then sources served from a live worktree, then branches served from blobs. Cached for 5 s. Only 'here' outside a repo. */
export async function listSources(root: string): Promise<Source[]> {
  return (await repo(root)).sources;
}

/** A project-relative path inside a branch: '' for the root; `..`, absolute and NUL are refused (403). */
function branchRel(rel: string): string {
  if (rel.includes('\0') || rel.startsWith('/') || rel.includes('\\')) throw new SourceError(403, 'outside project');
  const norm = path.posix.normalize(rel || '.');
  if (norm === '..' || norm.startsWith('../')) throw new SourceError(403, 'outside project');
  return norm === '.' ? '' : norm.replace(/\/$/, '');
}

/** `<ref>:<path>` pieces for a branch path: git runs at the top level, so the project prefix is prepended. */
async function branchSpec(root: string, src: Source, rel: string) {
  const r = branchRel(rel);
  const { top, prefix } = await repo(root);
  const full = (prefix + r).replace(/\/$/, '');
  return { top, full, ref: `refs/heads/${src.ref}` };
}

/** Type and size of one branch entry; null when missing. */
async function entryOf(top: string, ref: string, full: string): Promise<{ type: string; size: number } | null> {
  if (!full) return { type: 'tree', size: 0 };
  const out = (await gitText(top, ['ls-tree', '-l', '--full-tree', ref, '--', full])).trim();
  const m = /^\d+ (\w+) [0-9a-f]+ +(-|\d+)\t/.exec(out);
  return m ? { type: m[1], size: m[2] === '-' ? 0 : Number(m[2]) } : null;
}

function baseOf(root: string, src: Source): string {
  return src.dir ?? path.resolve(root);
}

/** A folder of a source: worktree/checkout via listDir under its own dir, a branch via `git ls-tree`. */
export async function readTree(root: string, src: Source, rel: string): Promise<TreeEntry[]> {
  if (src.kind !== 'branch') {
    const base = baseOf(root, src);
    const abs = resolveInRoot(base, rel);
    if (abs === null) throw new SourceError(403, 'outside project');
    return listDir(abs, base);
  }
  const { top, full, ref } = await branchSpec(root, src, rel);
  const e = await entryOf(top, ref, full);
  if (e?.type !== 'tree') throw new SourceError(404, 'not found');
  const out = await git(top, ['ls-tree', '-z', '--full-tree', ref, '--', ...(full ? [`${full}/`] : [])]);
  const list: TreeEntry[] = [];
  for (const line of out.toString('utf8').split('\0')) {
    const m = /^\d+ (\w+) [0-9a-f]+\t(.+)$/s.exec(line);
    if (!m) continue;
    const name = m[2].slice(m[2].lastIndexOf('/') + 1);
    if (HIDDEN.has(name) || (m[1] !== 'tree' && m[1] !== 'blob')) continue; // a submodule (commit) cannot be shown
    list.push({ name, dir: m[1] === 'tree' });
  }
  return sortEntries(list);
}

/** Size of a branch blob, for HEAD; null when missing or not a file; SourceError 413 above the cap, like a GET. */
export async function blobSize(root: string, src: Source, rel: string): Promise<number | null> {
  const { top, full, ref } = await branchSpec(root, src, rel);
  const e = await entryOf(top, ref, full);
  if (e?.type !== 'blob') return null;
  if (e.size > limits.blobMax) throw new SourceError(413, 'too large');
  return e.size;
}

/**
 * A file of a source; null when missing. A branch blob is read whole (`git cat-file blob <ref>:<path>`: the exact
 * bytes, no textconv), at most 50 MB (SourceError 413 above).
 */
export async function readFile(root: string, src: Source, rel: string): Promise<Buffer | null> {
  if (src.kind !== 'branch') {
    const abs = resolveInRoot(baseOf(root, src), rel);
    if (abs === null) throw new SourceError(403, 'outside project');
    try {
      if (!(await fs.promises.stat(abs)).isFile()) return null;
      return await fs.promises.readFile(abs);
    } catch {
      return null;
    }
  }
  const { top, full, ref } = await branchSpec(root, src, rel);
  const e = await entryOf(top, ref, full);
  if (e?.type !== 'blob') return null;
  if (e.size > limits.blobMax) throw new SourceError(413, 'too large');
  return git(top, ['cat-file', 'blob', `${ref}:${full}`], limits.blobMax + 1);
}

/** A branch's files (and `dir/` entries) under the project, for /complete; capped at 20 000 files. */
export async function branchFiles(root: string, src: Source): Promise<string[]> {
  const { top, full, ref } = await branchSpec(root, src, '');
  const out = await git(top, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', ref, '--', ...(full ? [`${full}/`] : [])], 64 << 20);
  const cut = full ? full.length + 1 : 0;
  const files = out.toString('utf8').split('\0').filter(Boolean).map((p) => p.slice(cut))
    .filter((p) => !p.split('/').some((seg) => HIDDEN.has(seg)));
  return withDirs(files.slice(0, FILES_CAP));
}

/** Branch and dirty state of the root for the header. */
export type GitStatus = { branch: string | null; detached: boolean; dirty: boolean };
const STATUS_TTL = 3_000;
const STATUS_TIMEOUT = 3_000;

async function readStatus(root: string): Promise<GitStatus | null> {
  const run = async (args: string[]) => (await git(root, ['-c', 'core.fsmonitor=false', ...args], 1 << 20, STATUS_TIMEOUT)).toString('utf8');
  try {
    let branch: string | null;
    let detached = false;
    try {
      const head = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      detached = head === 'HEAD';
      branch = detached ? null : head;
    } catch {
      // a repo without commits has no HEAD to resolve, but its branch name is known
      branch = (await run(['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null;
    }
    // new files the agent made count too (not the ignored ones); a huge untracked tree that times out falls back to
    // the tracked files only, so the header still shows something
    const status = (u: string) => run(['status', '--porcelain=v1', u, '--ignore-submodules']).then((o) => o.trim() !== '');
    const dirty = await status('-unormal').catch(() => status('-uno'));
    return { branch, detached, dirty };
  } catch {
    return null; // not a repo, no git, a timeout
  }
}

const statusCache = new Map<string, { at: number; p: Promise<GitStatus | null> }>();
/** Test hook. */
export const clearStatusCache = () => statusCache.clear();

/** The current branch (or detached) and whether there are uncommitted changes or new files; null outside a repo. Cached per root for 3 s. */
export function gitStatus(root: string): Promise<GitStatus | null> {
  const hit = statusCache.get(root);
  if (hit && Date.now() - hit.at < STATUS_TTL) return hit.p;
  const p = readStatus(root);
  statusCache.set(root, { at: Date.now(), p });
  return p;
}
