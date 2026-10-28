// The window registry: one file per port, <stateDir>/windows/<port>.json = { root, pid, launcherPid?, startedAt }.
// Written by the launcher (bin/nota-bene.mjs, which imports this file directly) when a server answers /info, and by
// a supervised server itself when its root changes (a folder switch); read by `nota-bene --find`. One file per port
// keeps writers of different ports from ever touching each other's entries; each file is replaced atomically.
// An entry is only a hint: every reader verifies it (pid alive + /info.root), because a window can be killed
// without unregistering, and its port reused by another app.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './state.ts';

export type WindowEntry = {
  root: string;
  /** the server process: its liveness is the window's */
  pid: number;
  /** the supervising launcher (survives the server's relaunches) */
  launcherPid?: number;
  startedAt: number;
};

const dir = () => path.join(stateDir(), 'windows');
const fileOf = (port: number | string) => path.join(dir(), `${port}.json`);

function readEntry(port: number | string): WindowEntry | undefined {
  try {
    const w: unknown = JSON.parse(fs.readFileSync(fileOf(port), 'utf8'));
    return w && typeof w === 'object' && typeof (w as WindowEntry).root === 'string' ? (w as WindowEntry) : undefined;
  } catch {
    return undefined;
  }
}

export function readWindows(): Record<string, WindowEntry> {
  let names: string[];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return {};
  }
  const out: Record<string, WindowEntry> = {};
  for (const n of names) {
    const m = /^(\d+)\.json$/.exec(n);
    if (!m) continue;
    const w = readEntry(m[1]!);
    if (w) out[m[1]!] = w;
  }
  return out;
}

export function registerWindow(port: number, root: string, pid: number, launcherPid?: number): void {
  fs.mkdirSync(dir(), { recursive: true });
  const f = fileOf(port);
  const tmp = `${f}.tmp${process.pid}`;
  const entry: WindowEntry = { root, pid, ...(launcherPid !== undefined ? { launcherPid } : {}), startedAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, f);
}

/** Removes the port's entry only if it is still this pid's (or unreadable): a newer window on the port keeps its own. */
export function unregisterWindow(port: number, pid: number): void {
  if (fs.existsSync(fileOf(port)) && (readEntry(port)?.pid ?? pid) === pid) fs.rmSync(fileOf(port), { force: true });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

/** GET http://127.0.0.1:PORT/info → { root } or null (no answer, not ours, not JSON). */
export async function probeInfo(port: number, timeoutMs = 500): Promise<{ root: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j: unknown = await r.json();
    const root = j && typeof j === 'object' ? (j as { root?: unknown }).root : undefined;
    return typeof root === 'string' ? { root } : null;
  } catch {
    return null;
  }
}

/**
 * A restarting window: its server is down (crashed, or exited 75) but its launcher is alive and relaunches it on the
 * same port. The launcher keeps the entry across relaunches, so the port stays reserved for it.
 */
const restarting = (w: WindowEntry): boolean => !pidAlive(w.pid) && w.launcherPid !== undefined && pidAlive(w.launcherPid);

/** The entries of windows in a restart gap (see `restarting`). */
export function restartingWindows(): { port: number; root: string }[] {
  return Object.entries(readWindows())
    .filter(([, w]) => restarting(w))
    .map(([key, w]) => ({ port: Number(key), root: w.root }))
    .sort((a, b) => a.port - b.port);
}

/**
 * The registered windows that are really there: pid alive and /info.root equal to the entry's root.
 * Proven-stale entries (dead pid and dead launcher, or the port answers with another root) are pruned; a restarting
 * entry is kept but not listed; an entry whose pid is alive but whose /info does not answer is skipped and kept
 * (a busy server is not proof of a stale entry).
 */
export async function liveWindows(
  probe: (port: number) => Promise<{ root: string } | null>,
): Promise<{ port: number; root: string }[]> {
  const entries = Object.entries(readWindows());
  const live: { port: number; root: string }[] = [];
  await Promise.all(entries.map(async ([key, w]) => {
    const port = Number(key);
    if (!pidAlive(w.pid)) {
      if (!restarting(w)) unregisterWindow(port, w.pid);
      return;
    }
    const got = await probe(port);
    if (got === null) return;
    if (got.root === w.root) live.push({ port, root: w.root });
    else unregisterWindow(port, w.pid);
  }));
  return live.sort((a, b) => a.port - b.port);
}
