import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { IMAGE_TYPES } from '@nota-bene/shared';
import type { ImageType } from '@nota-bene/shared';

// 5 MiB * 3/4: the API rejects a base64 image above 5 MiB, and base64 inflates raw bytes by 4/3. A rejected
// image stays in the transcript and can break later turns, so the cap is on the raw bytes. The client's downscale
// target (3.5e6) stays below it.
export const MAX_ATTACHMENT_BYTES = 3_932_160;

const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID_RE = /^[0-9a-f]{64}$/;

export function isImageType(v: unknown): v is ImageType {
  return typeof v === 'string' && (IMAGE_TYPES as readonly string[]).includes(v);
}

/** Content-addressed image files: `<sha256>.<ext>`. Same bytes, same file. */
export class AttachmentStore {
  private readonly dir: string;

  constructor(o: { dir: string }) {
    this.dir = o.dir;
  }

  /**
   * The first media type stored for given bytes is canonical: the same bytes posted again under another type
   * return the existing id and write nothing.
   */
  put(bytes: Buffer, mediaType: ImageType): string {
    const id = createHash('sha256').update(bytes).digest('hex');
    if (this.find(id)) return id;
    const file = path.join(this.dir, `${id}.${EXT[mediaType]}`);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    return id;
  }

  private find(id: string): ImageType | null {
    return IMAGE_TYPES.find((t) => fs.existsSync(path.join(this.dir, `${id}.${EXT[t]}`))) ?? null;
  }

  /** null when absent or the id is malformed; other disk errors are thrown. */
  get(id: string): { bytes: Buffer; mediaType: ImageType } | null {
    if (!ID_RE.test(id)) return null;
    for (const mediaType of IMAGE_TYPES) {
      try {
        return { bytes: fs.readFileSync(path.join(this.dir, `${id}.${EXT[mediaType]}`)), mediaType };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return null;
  }
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/** Reads the body, stopping as soon as more than `max` bytes have arrived (null = too large). */
function readCapped(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > max) {
        cleanup();
        resolve(null);
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function attachmentRoutes(store: AttachmentStore, hub?: EventHub): Record<string, RequestListener> {
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    if (hub) reportError(hub, req.url ?? '/attach', e);
    if (!res.headersSent) plain(res, 500, e instanceof Error ? e.message : String(e));
    else res.destroy();
  };
  return {
    // POST /attach: raw image bytes, content-type = the image type
    '/attach': (req, res) => {
      if (req.method !== 'POST') return plain(res, 405, 'method not allowed', { allow: 'POST' });
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (!isImageType(type)) return plain(res, 415, 'unsupported media type');
      void (async () => {
        try {
          const bytes = await readCapped(req, MAX_ATTACHMENT_BYTES);
          if (bytes === null) {
            // nothing is buffered any more; drain the rest briefly, then drop the connection only if the body is still unfinished (no `connection: close`: it resets the client mid-upload before it can read the 413)
            req.resume();
            setTimeout(() => { if (!req.complete) req.destroy(); }, 2000).unref();
            return plain(res, 413, 'attachment too large');
          }
          const id = store.put(bytes, type);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ id, mediaType: type }));
        } catch (e) {
          fail(req, res, e);
        }
      })();
    },
    // GET /attach/<id>: http.ts matches this key by prefix
    '/attach/': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      const id = (req.url ?? '').split('?')[0]!.slice('/attach/'.length);
      let found: ReturnType<AttachmentStore['get']> = null;
      try {
        found = store.get(id);
      } catch (e) {
        return fail(req, res, e);
      }
      if (!found) return plain(res, 404, 'not found');
      res.writeHead(200, {
        'content-type': found.mediaType,
        'content-length': found.bytes.length,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : found.bytes);
    },
  };
}
