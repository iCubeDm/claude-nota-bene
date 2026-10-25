import { useSyncExternalStore } from 'react';
import type { Source } from '@nota-bene/shared';

/**
 * Where files are read from (M3-16): this checkout ('here'), other worktrees and branches, all read-only. The list
 * lives outside Redux on purpose: Markdown (rendered without a store in places) marks absolute worktree paths from it.
 */
export const HERE: Source = { id: 'here', kind: 'checkout', label: '', ref: '' };
const TTL = 5_000;

let list: Source[] = [HERE];
let at = 0;
let inflight: Promise<Source[]> | null = null;
let seq = 0; // the latest request: only its answer is applied
const listeners = new Set<() => void>();

export const getSources = (): Source[] => list;
/** Whether the list came from the server at least once (before that, an unknown id proves nothing). */
export const sourcesKnown = (): boolean => at > 0;

/** Replaces the list; listeners (Markdown re-marking refs, the picker) hear only about a real change. */
export function setSources(next: Source[]): void {
  const v = next.some((s) => s.id === 'here') ? next : [HERE, ...next];
  const first = at === 0; // the first answer flips sourcesKnown(), which views read
  at = Date.now();
  if (!first && JSON.stringify(v) === JSON.stringify(list)) return;
  list = v;
  for (const fn of listeners) fn();
}

/** Test hook: back to "only here", nothing cached. */
export function resetSources(): void {
  list = [HERE];
  at = 0;
  inflight = null;
  seq++; // an answer in flight belongs to the old state
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const useSources = (): Source[] => useSyncExternalStore(subscribe, getSources);

const isSource = (v: unknown): v is Source => {
  const s = v as Source;
  return !!s && typeof s.id === 'string' && typeof s.label === 'string' && typeof s.ref === 'string'
    && ['checkout', 'worktree', 'branch'].includes(s.kind) && (s.dir === undefined || typeof s.dir === 'string')
    && (s.alias === undefined || typeof s.alias === 'string');
};

/**
 * GET /sources, cached for 5 s. A failure keeps the last list. `force` skips the cache and starts a fresh request: an
 * answer still in flight is dropped (after a switch to another root it lists the old root's sources).
 */
export function loadSources(force = false): Promise<Source[]> {
  if (!force && at && Date.now() - at < TTL) return Promise.resolve(list);
  if (!force && inflight) return inflight;
  const mine = ++seq;
  const p = (async () => {
    try {
      const r = await fetch('/sources');
      const v: unknown = r.ok ? await r.json() : null;
      if (mine === seq && Array.isArray(v) && v.every(isSource)) setSources(v);
    } catch {
      // offline or no server: keep what we have
    } finally {
      if (mine === seq) inflight = null; // a newer request owns `inflight` otherwise
    }
    return list;
  })();
  inflight = p;
  return p;
}

export const sourceById = (id: string): Source | undefined => list.find((s) => s.id === id);
/**
 * The ref a tab or comment carries for a source: none for 'here'; the branch for `ref:<branch>` (from the id itself);
 * `(detached) <folder>` for a `dir:` worktree (from the list).
 */
export const refOf = (id: string): string | undefined =>
  id === 'here' ? undefined : id.startsWith('ref:') ? id.slice(4) : sourceById(id)?.ref || undefined;
/**
 * The source id of a comment's ref. A branch name maps to `ref:<name>` directly, whether or not it still exists (the
 * view then says so); a detached worktree's ref is looked up in the list (undefined when it is gone).
 */
export const srcIdOfRef = (ref: string | undefined): string | undefined =>
  ref === undefined ? 'here' : ref.startsWith('(detached) ') ? list.find((s) => s.ref === ref)?.id : `ref:${ref}`;
/** A source served from git blobs only changes with a commit: no reload after a turn. Unknown = reload (harmless). */
export const isFixed = (id: string, from: Source[] = list): boolean => from.find((s) => s.id === id)?.kind === 'branch';

/** The source whose dir holds an absolute path (the longest dir wins: worktrees often sit inside the project), with the path relative to it. */
export function sourceForAbs(abs: string, from: Source[] = list): { src: string; path: string } | null {
  let best: { src: string; path: string; len: number } | null = null;
  for (const s of from) {
    if (s.kind === 'branch' || !s.dir) continue;
    // the server sends realpaths, plus the form it was given when that differs (macOS /var vs /private/var)
    for (const raw of [s.dir, s.alias]) {
      const d = raw?.replace(/\/+$/, '');
      if (!d || !abs.startsWith(d + '/')) continue;
      const rel = abs.slice(d.length + 1).replace(/\/+$/, '');
      if (rel && (!best || d.length > best.len)) best = { src: s.id, path: rel, len: d.length };
    }
  }
  return best && { src: best.src, path: best.path };
}

/** Key of a file across sources (load states, comment counts): the path alone for 'here'. NUL never occurs in a path. */
export const fileKey = (path: string, ref?: string): string => (ref ? `${path}\u0000${ref}` : path);
