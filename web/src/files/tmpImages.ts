import { useSyncExternalStore } from 'react';
import { apiFetch } from '@/net/auth.ts';

/**
 * Images of the server's temp folders (a screenshot the agent left in /tmp). The tab is a plain file tab whose path is
 * ABSOLUTE: a project path is always relative, so an absolute path in a tab means a temp image, with no new source id,
 * tab kind or comment store (comments are keyed by that path like any file's). The bytes come from `/tmpimage` on the key
 * tier, never `/file`, through apiFetch into a blob (see useTmpImage).
 */
const IMG = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

let dirs: string[] = [];
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** The temp folders the server named in its hello; none until then (nothing is linked on a guess). */
export function setTmpDirs(next: string[] | undefined): void {
  const v = (next ?? []).filter((d) => typeof d === 'string' && d.startsWith('/') && d.length > 1).map((d) => d.replace(/\/+$/, ''));
  if (v.join('\n') === dirs.join('\n')) return;
  dirs = v;
  for (const fn of listeners) fn();
}
export const getTmpDirs = (): string[] => dirs;
export const useTmpDirs = (): string[] => useSyncExternalStore(subscribe, getTmpDirs);

/** An absolute image path lexically under a temp folder (no `..`, no forbidden characters). The server decides for real. */
export function isTmpImagePath(abs: string, from: string[] = dirs): boolean {
  if (!abs.startsWith('/') || abs.startsWith('//') || /[\n\0`<>|*]/.test(abs) || !IMG.test(abs)) return false;
  if (abs.split('/').some((s) => s === '..' || s === '.')) return false;
  return from.some((d) => abs.startsWith(d + '/') && abs.length > d.length + 1);
}

/** A tab path that is a temp image (any absolute path: project paths are relative). */
export const isTmpTabPath = (path: string): boolean => path.startsWith('/') && IMG.test(path);

export const tmpImageUrl = (abs: string, bust = 0): string => `/tmpimage?path=${encodeURIComponent(abs)}${bust ? `&r=${bust}` : ''}`;

/** Temp image paths in a line of text (a Bash command, a Read's file_path), in order, without duplicates. */
export function tmpImagePathsIn(text: string, from: string[] = dirs): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s"'=(:])(\/[^\s"'`<>|*;()]+)/g)) {
    const p = m[1]!;
    if (isTmpImagePath(p, from) && !out.includes(p)) out.push(p);
  }
  return out;
}

export type TmpLoad = { s: 'loading' } | { s: 'ok'; url: string } | { s: 'gone' } | { s: 'big' } | { s: 'error' };
export type TmpFetched = { s: 'ok'; blob: Blob } | { s: 'gone' } | { s: 'big' } | { s: 'error' };

/** GET `/tmpimage?...` with the key into bytes; the status maps to what the view says. */
export async function fetchTmpImage(url: string, signal: AbortSignal): Promise<TmpFetched> {
  const r = await apiFetch(url, { signal, cache: 'no-store' });
  if (r.status === 404) return { s: 'gone' };
  if (r.status === 413) return { s: 'big' };
  if (!r.ok) return { s: 'error' };
  return { s: 'ok', blob: await r.blob() };
}
