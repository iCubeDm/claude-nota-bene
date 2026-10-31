import fs from 'node:fs';
import type { RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ServerEvent } from '@nota-bene/shared';
import { SAFE_SESSION_ID } from './comments.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';

type Line = { segment: number; events: ServerEvent[] };

/** a replay never needs the streaming frames (the transcript replay has none either): R-M7-1 */
const streamed = (ev: ServerEvent) => ev.kind === 'agent' && (ev.e.t === 'message-start' || ev.e.t === 'message-chunk');

/**
 * The conversation before each compaction (R-M7-1): the SDK replays a session only from its last compaction, so the
 * server keeps the part it cut. `<dir>/<sessionId>.jsonl`, one line per segment, `{"segment":n,"events":[…]}`,
 * numbered from 1 in the order they were cut. Every line is fsync'd before append returns (and the directory, when
 * the file is new); an fsync failure after the full write is reported and the segment counts as written.
 *
 * A line that does not parse (a torn write, a hand edit) is skipped and reported once per session; it keeps its
 * number (the next append is numbered after every line, valid or not), so no two lines ever share a number.
 */
export class HistoryArchive {
  private readonly dir: string;
  private readonly report: (e: Error) => void;
  private readonly reported = new Set<string>();

  constructor(o: { dir: string; report?: (e: Error) => void }) {
    this.dir = o.dir;
    this.report = o.report ?? ((e) => console.error('[archive]', e));
  }

  /** Appends one segment; returns its number, or 0 when nothing was left to store (no line is written). */
  append(sessionId: string, events: ServerEvent[]): number {
    const file = this.file(sessionId);
    const kept = events.filter((ev) => !streamed(ev));
    if (kept.length === 0) return 0;
    const { lines, valid, torn } = this.read(sessionId, file);
    const n = Math.max(lines, ...valid.map((l) => l.segment)) + 1;
    fs.mkdirSync(this.dir, { recursive: true });
    const created = !fs.existsSync(file);
    // a torn last line (a crash mid-write) is closed first, so the new segment starts on a line of its own
    const line = Buffer.from(`${torn ? '\n' : ''}${JSON.stringify({ segment: n, events: kept } satisfies Line)}\n`);
    const fd = fs.openSync(file, 'a');
    try {
      for (let off = 0; off < line.length;) off += fs.writeSync(fd, line, off, line.length - off); // a short write goes on
      // the line is out: an fsync failure is reported, not thrown, or the caller would not cut and the next
      // compaction would archive the same events again
      this.sync(() => fs.fsyncSync(fd));
    } finally {
      fs.closeSync(fd);
    }
    if (created) this.sync(() => { const d = fs.openSync(this.dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }); // the new name
    return n;
  }

  /** The highest segment number stored (0 for none): `before(id, count + 1)` gives the newest segment. */
  count(sessionId: string): number {
    const { valid } = this.read(sessionId, this.file(sessionId));
    return valid.reduce((m, l) => Math.max(m, l.segment), 0);
  }

  /** All saved segments in chronological order, for native runtimes that also retain precompaction history. */
  events(sessionId: string): ServerEvent[] {
    return this.read(sessionId, this.file(sessionId)).valid.sort((a, b) => a.segment - b.segment).flatMap((line) => line.events);
  }

  segment(sessionId: string, n: number): ServerEvent[] | null {
    return this.read(sessionId, this.file(sessionId)).valid.find((l) => l.segment === n)?.events ?? null;
  }

  /** The newest segment numbered below `n` (a corrupt one is skipped), and whether an older one exists. */
  before(sessionId: string, n: number): { events: ServerEvent[]; segment: number; more: boolean } | null {
    const below = this.read(sessionId, this.file(sessionId)).valid.filter((l) => l.segment < n).sort((a, b) => b.segment - a.segment);
    const top = below[0];
    return top ? { events: top.events, segment: top.segment, more: below.length > 1 } : null;
  }

  private sync(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.report(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private file(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  private read(sessionId: string, file: string): { lines: number; valid: Line[]; torn: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // only a missing file is "no archive"; EACCES/EIO must not look empty (the next append would renumber)
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { lines: 0, valid: [], torn: false };
      throw e;
    }
    const torn = raw.length > 0 && !raw.endsWith('\n');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const valid: Line[] = [];
    let bad = 0;
    for (const l of lines) {
      const v = parse(l);
      if (v) valid.push(v);
      else bad++;
    }
    if (bad && !this.reported.has(sessionId)) {
      this.reported.add(sessionId);
      this.report(new Error(`history/${sessionId}.jsonl: ${bad} corrupt line(s) skipped`));
    }
    return { lines: lines.length, valid, torn };
  }
}

function parse(line: string): Line | null {
  try {
    const v = JSON.parse(line) as Partial<Line> | null;
    if (!v || typeof v !== 'object' || !Number.isInteger(v.segment) || (v.segment as number) < 1 || !Array.isArray(v.events)) return null;
    return { segment: v.segment as number, events: v.events };
  } catch {
    return null;
  }
}

function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * `GET /history?session=<id>&before=<n>` (R-M7-4): one segment per request, newest first. 200 `{events, segment,
 * more}` for the newest segment below `n` (`before: earlier + 1` starts at the newest), 404 when there is none,
 * 409 when `session` is not the current conversation (only its archive is served: a page from before a switch or a
 * /clear must not page another one into its feed).
 */
export function historyRoutes(archive: HistoryArchive, current: () => string | null, hub: EventHub): Record<string, RequestListener> {
  return {
    '/history': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const session = q.get('session') ?? '';
      const raw = q.get('before') ?? '';
      const before = /^[0-9]{1,9}$/.test(raw) ? Number(raw) : 0;
      if (!SAFE_SESSION_ID.test(session) || before < 1) return text(res, 400, 'bad request');
      if (session !== current()) return text(res, 409, 'not the current session'); // also: no own id yet (null)
      let page: ReturnType<HistoryArchive['before']>;
      try {
        page = archive.before(session, before);
      } catch (e) {
        reportError(hub, 'archive', e);
        return text(res, 500, 'internal error');
      }
      if (!page) return text(res, 404, 'no such segment');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(page));
    },
  };
}
