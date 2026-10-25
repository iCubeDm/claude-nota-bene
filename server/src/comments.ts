import fs from 'node:fs';
import path from 'node:path';
import type { Comment } from '@nota-bene/shared';

const SAFE_ID = /^[0-9a-zA-Z-]{1,100}$/;

function fileFor(dir: string, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  return path.join(dir, `${sessionId}.json`);
}

/** Per-session comment sets, one JSON file per session. The not-yet-identified session (null) lives in memory only. */
export class CommentStore {
  private readonly dir: string;
  private pending: Comment[] = [];

  constructor(o: { dir: string }) {
    this.dir = o.dir;
  }

  get(sessionId: string | null): Comment[] {
    if (sessionId === null) return [...this.pending];
    const file = fileFor(this.dir, sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // only a missing file is "no comments"; EACCES/EIO must not look empty (the next set() would overwrite the real file)
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data.filter((c): c is Comment => typeof c === 'object' && c !== null && typeof (c as { id?: unknown }).id === 'string');
  }

  set(sessionId: string | null, items: Comment[]): void {
    if (sessionId === null) {
      this.pending = [...items];
      return;
    }
    const file = fileFor(this.dir, sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Moves the in-memory set under the real id (no-op when there is nothing to move). */
  adopt(sessionId: string): void {
    fileFor(this.dir, sessionId);
    if (this.pending.length === 0) return;
    // merge by id; the stored entry wins on conflict (resumed session already has it)
    const stored = this.get(sessionId);
    const have = new Set(stored.map((c) => c.id));
    this.set(sessionId, [...stored, ...this.pending.filter((c) => !have.has(c.id))]);
    this.pending = [];
  }

  /** Marks the given comments as sent in `sentIn`; returns the full updated set. */
  markSent(sessionId: string | null, ids: string[], sentIn: string): Comment[] {
    const want = new Set(ids);
    const next = this.get(sessionId).map((c): Comment => (want.has(c.id) ? { ...c, status: 'sent', sentIn } : c));
    this.set(sessionId, next);
    return [...next];
  }
}
