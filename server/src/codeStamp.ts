import fs from 'node:fs';
import path from 'node:path';

/** How long a "no change" answer is reused: /info is polled by every window, a tree walk per poll is waste. */
export const TTL_MS = 5_000;

/** The server's own sources (not the project's): a `.ts` edit under these is not running until the server restarts. */
function newerThan(dir: string, since: number): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; } // missing dir = not changed
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (newerThan(p, since)) return true; continue; }
    if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
    try { if (fs.statSync(p).mtimeMs > since) return true; } catch { /* vanished mid-scan */ }
  }
  return false;
}

/**
 * Lazy "was the code edited after this process started": scanned only when asked, cached for `ttlMs`; once true it
 * stays true (the process is stale for good). No fs.watch: it costs descriptors and leaks on a long-lived server.
 */
export function codeChecker(o: { repoDir: string; startedAt?: number; ttlMs?: number; now?: () => number }): () => boolean {
  const startedAt = o.startedAt ?? Date.now() - process.uptime() * 1000;
  const ttl = o.ttlMs ?? TTL_MS;
  const now = o.now ?? Date.now;
  let changed = false;
  let checkedAt = -Infinity;
  return () => {
    if (changed) return true;
    const t = now();
    if (t - checkedAt < ttl) return false;
    checkedAt = t;
    try {
      changed = ['server', 'shared'].some((d) => newerThan(path.join(o.repoDir, d, 'src'), startedAt));
    } catch { changed = false; }
    return changed;
  };
}
