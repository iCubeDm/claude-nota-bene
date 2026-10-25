import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { EventHub } from './hub.ts';
import { reportError } from './errors.ts';
import { listDir, resolveInRoot } from './files.ts';
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
      listDir(abs).then(
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
