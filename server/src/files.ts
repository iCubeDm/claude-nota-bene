import fs from 'node:fs';
import path from 'node:path';
import type { TreeEntry } from '@nota-bene/shared';

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);
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

export async function listDir(abs: string): Promise<TreeEntry[]> {
  const ents = await fs.promises.readdir(abs, { withFileTypes: true });
  const out: TreeEntry[] = [];
  for (const e of ents) {
    if (HIDDEN.has(e.name)) continue;
    let dir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        dir = (await fs.promises.stat(path.join(abs, e.name))).isDirectory();
      } catch {
        // dangling link: shown as a file
      }
    }
    out.push({ name: e.name, dir });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
}

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

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
      if (HIDDEN.has(e.name)) continue;
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

export function listFiles(root: string): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL) return hit.files;
  const files = walk(root);
  cache.set(root, { at: Date.now(), files });
  files.catch(() => cache.delete(root));
  return files;
}

// fuzzy score: -1 = no match; subsequence match, bonus for basename hits and consecutive letters
function fuzzy(p: string, q: string): number {
  const s = p.toLowerCase();
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (base.startsWith(q)) return 1000 - p.length;
  if (base.includes(q)) return 800 - p.length;
  if (s.includes(q)) return 600 - p.length;
  let i = 0;
  let score = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return -1;
    score += j === i ? 3 : 1;
    i = j + 1;
  }
  return score - p.length / 1000;
}

/** Own @-completion over the file list (at most 30 paths). */
export async function completeFiles(root: string, q: string): Promise<string[]> {
  const lq = q.toLowerCase();
  const all = await listFiles(root);
  if (!lq) return all.slice(0, 30);
  return all
    .map((p) => [p, fuzzy(p, lq)] as const)
    .filter(([p, sc]) => sc >= 0 && p !== q)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([p]) => p);
}
