import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { EventHub } from './hub.ts';
import { reportError } from './errors.ts';
import { listDir, listFiles, resolveInRoot } from './files.ts';
import { blobSize, branchFiles, gitStatus, listSources, readFile, readTree, SourceError, type Source } from './git.ts';
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

/**
 * The `src` of a request: none or 'here' is this checkout (no git call); anything else must be an id from the current
 * listSources, never a path or a raw ref. null = unknown (the route answers 400).
 */
async function sourceOf(req: IncomingMessage, root: string): Promise<Source | 'here' | null> {
  const id = new URL(req.url ?? '/', 'http://x').searchParams.get('src');
  if (id === null || id === 'here') return 'here';
  return (await listSources(root)).find((s) => s.id === id && s.kind !== 'checkout') ?? null;
}

// project files are untrusted: an .svg/.html must not run script on our origin
const SAFETY = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  'cross-origin-resource-policy': 'same-origin',
};

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
  o: { session: Pick<AgentSession, 'fileSuggestions'>; root: string; timeoutMs?: number; files?: () => Promise<string[]> },
  raw: string,
): Promise<string[]> {
  const lq = raw.toLowerCase();
  const cli = new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('file_suggestions timeout')), o.timeoutMs ?? CLI_TIMEOUT);
    o.session.fileSuggestions(raw).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const [cliRes, ours] = await Promise.allSettled([cli, lq ? (o.files ?? (() => listFiles(o.root)))() : Promise.resolve([] as string[])]);
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
  /** read once per request: the root changes when the session switches to another project */
  root: () => string;
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

  const json = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
  /** Runs `fn` with the request's source and the root as of the request; 400 for an unknown source. */
  const withSource = (req: IncomingMessage, res: ServerResponse, fn: (src: Source | 'here', root: string) => Promise<void> | void) => {
    const root = o.root();
    sourceOf(req, root).then(
      (src) => (src === null ? plain(res, 400, 'unknown source') : fn(src, root)),
      (e) => fail(req, res, e),
    ).catch((e) => fail(req, res, e));
  };
  const sourceFail = (req: IncomingMessage, res: ServerResponse, e: unknown) =>
    e instanceof SourceError ? plain(res, e.status, e.message) : fail(req, res, e);

  /** A file under `base` (this checkout or a worktree): resolveInRoot, Range, the safety headers, a streamed body. */
  const serveFs = (req: IncomingMessage, res: ServerResponse, base: string) => {
    const abs = resolveInRoot(base, queryPath(req));
    if (abs === null) return plain(res, 403, 'outside project');
    fs.promises.stat(abs).then(
      (st) => {
        if (!st.isFile()) return plain(res, 404, 'not found');
        const head = { 'content-type': typeOf(abs), 'accept-ranges': 'bytes', ...SAFETY };
        const range = parseRange(req.headers.range, st.size);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { 'content-range': `bytes */${st.size}` });
          res.end();
          return;
        }
        if (range) {
          res.writeHead(206, {
            ...head,
            'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
            'content-length': range.end - range.start + 1,
          });
        } else {
          res.writeHead(200, { ...head, 'content-length': st.size });
        }
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        // pipeline destroys the read stream when the client aborts (Chrome does this on every seek) and
        // ends only this response on a read error (file deleted mid-read)
        pipeline(fs.createReadStream(abs, range ? { start: range.start, end: range.end } : {}), res, (e) => {
          if (e && (e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            reportError(o.hub, path.relative(base, abs) || abs, e);
          }
        });
      },
      () => plain(res, 404, 'not found'),
    ).catch((e) => fail(req, res, e));
  };

  /**
   * A branch blob: the buffer (read whole, capped) sliced by Range like serveFs (206, 416), the same safety headers, a
   * content type from the path; HEAD gives the length (413 above the cap, like GET). Safari needs Range to play video.
   */
  const serveBlob = async (req: IncomingMessage, res: ServerResponse, root: string, src: Source) => {
    const rel = queryPath(req);
    const head = { 'content-type': typeOf(rel), 'accept-ranges': 'bytes', ...SAFETY };
    if (req.method === 'HEAD') {
      const size = await blobSize(root, src, rel);
      if (size === null) return plain(res, 404, 'not found');
      res.writeHead(200, { ...head, 'content-length': size });
      res.end();
      return;
    }
    const buf = await readFile(root, src, rel);
    if (buf === null) return plain(res, 404, 'not found');
    const range = parseRange(req.headers.range, buf.length);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
      res.end();
      return;
    }
    if (range) {
      res.writeHead(206, { ...head, 'content-range': `bytes ${range.start}-${range.end}/${buf.length}`, 'content-length': range.end - range.start + 1 });
      res.end(buf.subarray(range.start, range.end + 1));
      return;
    }
    res.writeHead(200, { ...head, 'content-length': buf.length });
    res.end(buf);
  };

  return {
    '/sources': (req, res) => {
      if (!getOnly(req, res)) return;
      listSources(o.root()).then((list) => json(req, res, 200, list), (e) => fail(req, res, e));
    },

    '/git-status': (req, res) => {
      if (!getOnly(req, res)) return;
      gitStatus(o.root()).then((st) => json(req, res, 200, st), () => json(req, res, 200, null));
    },

    '/tree': (req, res) => {
      if (!getOnly(req, res)) return;
      withSource(req, res, async (src, root) => {
        if (src === 'here') {
          const abs = resolveInRoot(root, queryPath(req));
          if (abs === null) return plain(res, 403, 'outside project');
          return listDir(abs, root).then((list) => json(req, res, 200, list), () => json(req, res, 404, []));
        }
        try {
          json(req, res, 200, await readTree(root, src, queryPath(req)));
        } catch (e) {
          if (e instanceof SourceError && e.status === 403) return plain(res, 403, e.message);
          json(req, res, 404, []); // a missing folder, like for this checkout
        }
      });
    },

    '/file': (req, res) => {
      if (!getOnly(req, res)) return;
      withSource(req, res, async (src, root) => {
        if (src === 'here') return serveFs(req, res, root);
        if (src.kind === 'worktree' && src.dir) return serveFs(req, res, src.dir);
        await serveBlob(req, res, root, src).catch((e) => sourceFail(req, res, e));
      });
    },

    '/complete': (req, res) => {
      if (!getOnly(req, res)) return;
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
      withSource(req, res, (src, root) => {
        // another source: our own file search over it (the CLI only knows this checkout)
        const run = src === 'here' ? o.complete(q)
          : complete({
            session: { fileSuggestions: async () => [] }, root: src.dir ?? root,
            files: src.kind === 'branch' ? () => branchFiles(root, src) : undefined,
          }, q);
        run.then((hits) => json(req, res, 200, hits.slice(0, 30)), (e) => fail(req, res, e));
      });
    },
  };
}
