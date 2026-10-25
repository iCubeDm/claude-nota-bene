import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { EventHub } from './hub.ts';
import { reportError } from './errors.ts';
import { listDir, listFiles, resolveInRoot } from './files.ts';
import { fuzzyScore } from './fuzzy.ts';
import type { AgentSession } from './agent/types.ts';
import { parseRange } from './range.ts';

// from the prototype's MIME table
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.py', '.sh', '.yml', '.yaml', '.toml', '.csv', '.log',
]);

function typeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  // known text files are shown as text, never executed/rendered by the browser
  if (TEXT_EXT.has(ext)) return 'text/plain; charset=utf-8';
  return MIME[ext] ?? 'application/octet-stream';
}

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function queryPath(req: IncomingMessage): string {
  // URLSearchParams decodes once; the value is never decoded again
  return new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '';
}

const CLI_TIMEOUT = 1500;

// the CLI answers with project-relative paths, but also absolute ones (skills, added dirs): inside the root
// they become relative, outside it they are dropped (the UI never gets a path it cannot open)
function relativeHit(root: string, p: string): string | null {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(path.resolve(root), p);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/') + (p.endsWith('/') ? '/' : '');
}

const baseOf = (p: string) => p.toLowerCase().replace(/\/$/, '').split('/').pop() ?? '';

/**
 * @-completion. The CLI's ranking stays (the user chose "the same search as Claude Code"), merged with ours,
 * because the CLI indexes tracked files only and answers [] or just skills while it is still indexing:
 * 1. our file-name-prefix hits the CLI did not return (new, untracked files);
 * 2. the CLI's project-relative hits, in its order;
 * 3. the rest of our fuzzy hits. At most 30 paths; an empty query gives the CLI's hits only.
 */
export async function complete(
  o: { session: Pick<AgentSession, 'fileSuggestions'>; root: string; timeoutMs?: number },
  raw: string,
): Promise<string[]> {
  const lq = raw.toLowerCase();
  const cli = new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('file_suggestions timeout')), o.timeoutMs ?? CLI_TIMEOUT);
    o.session.fileSuggestions(raw).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const [cliRes, ours] = await Promise.allSettled([cli, lq ? listFiles(o.root) : Promise.resolve([] as string[])]);
  const key = (p: string) => p.replace(/\/$/, '');
  const theirs: string[] = [];
  if (cliRes.status === 'fulfilled') {
    for (const p of cliRes.value) {
      const rel = relativeHit(o.root, p);
      if (rel !== null && key(rel) !== key(raw)) theirs.push(rel);
    }
  }
  const scored =
    ours.status === 'fulfilled' && lq
      ? ours.value
          .map((p) => [p, fuzzyScore(p, lq)] as const)
          .filter(([p, sc]) => sc >= 0 && key(p) !== key(raw))
          .sort((a, b) => b[1] - a[1])
          .map(([p]) => p)
      : [];
  const seen = new Set(theirs.map(key));
  const first = scored.filter((p) => baseOf(p).startsWith(lq) && !seen.has(key(p)));
  const out: string[] = [];
  const have = new Set<string>();
  for (const p of [...first, ...theirs, ...scored]) {
    if (have.has(key(p))) continue;
    have.add(key(p));
    out.push(p);
    if (out.length >= 30) break;
  }
  return out;
}

export function fileRoutes(o: {
  root: string;
  hub: EventHub;
  complete: (q: string) => Promise<string[]>;
}): Record<string, RequestListener> {
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    reportError(o.hub, req.url ?? '', e);
    if (!res.headersSent) plain(res, 500, e instanceof Error ? e.message : String(e));
    else res.destroy();
  };
  const getOnly = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return false;
  };

  return {
    '/tree': (req, res) => {
      if (!getOnly(req, res)) return;
      const abs = resolveInRoot(o.root, queryPath(req));
      if (abs === null) return plain(res, 403, 'outside project');
      listDir(abs, o.root).then(
        (list) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(list));
        },
        () => {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : '[]');
        },
      );
    },

    '/file': (req, res) => {
      if (!getOnly(req, res)) return;
      const abs = resolveInRoot(o.root, queryPath(req));
      if (abs === null) return plain(res, 403, 'outside project');
      fs.promises.stat(abs).then(
        (st) => {
          if (!st.isFile()) return plain(res, 404, 'not found');
          const base = {
            'content-type': typeOf(abs),
            'accept-ranges': 'bytes',
            // project files are untrusted: an .svg/.html must not run script on our origin
            'x-content-type-options': 'nosniff',
            'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
            'cross-origin-resource-policy': 'same-origin',
          };
          const range = parseRange(req.headers.range, st.size);
          if (range === 'unsatisfiable') {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` });
            res.end();
            return;
          }
          if (range) {
            res.writeHead(206, {
              ...base,
              'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
              'content-length': range.end - range.start + 1,
            });
          } else {
            res.writeHead(200, { ...base, 'content-length': st.size });
          }
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          // pipeline destroys the read stream when the client aborts (Chrome does this on every seek) and
          // ends only this response on a read error (file deleted mid-read)
          pipeline(fs.createReadStream(abs, range ? { start: range.start, end: range.end } : {}), res, (e) => {
            if (e && (e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
              reportError(o.hub, path.relative(o.root, abs) || abs, e);
            }
          });
        },
        () => plain(res, 404, 'not found'),
      ).catch((e) => fail(req, res, e));
    },

    '/complete': (req, res) => {
      if (!getOnly(req, res)) return;
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
      o.complete(q).then(
        (hits) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(hits.slice(0, 30)));
        },
        (e) => fail(req, res, e),
      );
    },
  };
}
