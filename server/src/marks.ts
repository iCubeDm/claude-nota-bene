import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { isMediaAnchor, MARK_MAX_BYTES } from '@nota-bene/shared';
import type { Comment } from '@nota-bene/shared';
import { readCapped, refuseTooLarge } from './attachments.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';

/**
 * The server's only write into the project folder: `<root>/.nota-bene/marks/<comment id>/{frame.jpg,layer.png}`.
 * Nothing from the client becomes a path except the id, which must match MARK_ID; the names are fixed.
 */
export const MARK_ID = /^[0-9a-f-]{36}$/;
export type MarkName = 'frame.jpg' | 'layer.png';

const NAMES: Record<MarkName, { type: string; magic: readonly number[] }> = {
  'frame.jpg': { type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  'layer.png': { type: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
};

export const isMarkName = (v: string): v is MarkName => Object.hasOwn(NAMES, v);

/** A refusal the client caused (bad input): `status` is the HTTP answer. */
export class MarkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function checkId(id: string): void {
  if (typeof id !== 'string' || !MARK_ID.test(id)) throw new MarkError(404, `invalid mark id: ${JSON.stringify(id)}`);
}

/** Creates `p` if missing; it must then be a real directory, never a symlink (lstat). */
function ensureDir(p: string): void {
  try {
    fs.mkdirSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  realDir(p);
}

/** Throws unless `p` is a real directory; false when it does not exist. */
function realDir(p: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`not a directory (or a symlink): ${p}`);
  return true;
}

export class MarkFiles {
  private readonly root: () => string;

  constructor(o: { root: () => string }) {
    this.root = o.root;
  }

  /** Writes `frame.jpg` | `layer.png` for comment `id` (creates `.nota-bene/.gitignore` = "*\n" if missing). Throws on a bad id/name/type, a symlinked dir, or bytes > MARK_MAX_BYTES. */
  write(id: string, name: MarkName, bytes: Buffer): void {
    checkId(id);
    if (!isMarkName(name)) throw new MarkError(404, `invalid mark name: ${JSON.stringify(name)}`);
    if (bytes.length > MARK_MAX_BYTES) throw new MarkError(413, 'mark too large');
    const { magic } = NAMES[name];
    if (bytes.length < magic.length || magic.some((b, i) => bytes[i] !== b)) throw new MarkError(400, `${name}: not a ${NAMES[name].type}`);

    // the project folder itself may be a symlink (the user chose it); everything below it may not
    const root = path.resolve(this.root());
    if (!fs.statSync(root).isDirectory()) throw new Error(`project root is not a directory: ${root}`);
    const nb = path.join(root, '.nota-bene');
    ensureDir(nb);
    try {
      // 'wx': only if missing, and never through a symlink (O_EXCL); the user's own .gitignore is never touched
      fs.writeFileSync(path.join(nb, '.gitignore'), '*\n', { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const marks = path.join(nb, 'marks');
    ensureDir(marks);
    const dir = path.join(marks, id);
    ensureDir(dir);
    // belt and braces against a swap between the checks: the folder must resolve to where it claims to be
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(root), '.nota-bene', 'marks', id)) {
      throw new Error(`mark folder escapes the project: ${dir}`);
    }
    const file = path.join(dir, name);
    const tmp = path.join(dir, `.${name}.tmp${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx' });
      fs.renameSync(tmp, file); // replaces `file` itself, even a symlink there, never its target
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Removes the comment's folder; a missing folder is fine. */
  remove(id: string): void {
    checkId(id);
    const root = path.resolve(this.root());
    const nb = path.join(root, '.nota-bene');
    const marks = path.join(nb, 'marks');
    const dir = path.join(marks, id);
    // every level is lstat-ed: a symlinked .nota-bene or marks must not make us delete elsewhere
    if (!realDir(nb) || !realDir(marks) || !realDir(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true }); // rm -r unlinks symlinks inside, never follows them
  }

  /** Media comments present in `prev` and absent from `next` lose their folder. */
  sync(prev: Comment[], next: Comment[]): void {
    const keep = new Set(next.map((c) => c.id));
    const errors: unknown[] = [];
    for (const c of prev) {
      if (keep.has(c.id) || !c.anchor || !isMediaAnchor(c.anchor) || !MARK_ID.test(c.id)) continue;
      try {
        this.remove(c.id);
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} mark folders not removed`);
  }
}

function plain(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * `POST /marks/<id>/<frame.jpg|layer.png>` (body = the bytes, Content-Type matching the name) and `DELETE /marks/<id>`,
 * both 204. Host and Origin are checked by httpHandler (any non-GET needs an allowed Origin). The path is not decoded:
 * an encoded id fails MARK_ID.
 */
export function markRoutes(marks: MarkFiles, hub?: EventHub): Record<string, RequestListener> {
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    if (e instanceof MarkError) return plain(res, e.status, e.message);
    if (hub) reportError(hub, '/marks', e);
    if (!res.headersSent) plain(res, 500, e instanceof Error ? e.message : String(e));
    else res.destroy();
  };
  return {
    // http.ts matches this key by prefix
    '/marks/': (req, res) => {
      const parts = (req.url ?? '').split('?')[0]!.slice('/marks/'.length).split('/');
      const [id, name] = parts;
      if (parts.length === 1) {
        if (req.method !== 'DELETE') return plain(res, 405, 'method not allowed', { allow: 'DELETE' });
        if (!MARK_ID.test(id!)) return plain(res, 404, 'not found');
        try {
          marks.remove(id!);
        } catch (e) {
          return fail(req, res, e);
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (parts.length !== 2) return plain(res, 404, 'not found');
      if (req.method !== 'POST') return plain(res, 405, 'method not allowed', { allow: 'POST' });
      if (!MARK_ID.test(id!) || !isMarkName(name!)) return plain(res, 404, 'not found');
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== NAMES[name].type) return plain(res, 415, `${name} must be ${NAMES[name].type}`);
      void (async () => {
        try {
          const bytes = await readCapped(req, MARK_MAX_BYTES);
          if (bytes === null) return refuseTooLarge(req, res, 'mark too large');
          marks.write(id!, name, bytes);
          res.writeHead(204);
          res.end();
        } catch (e) {
          fail(req, res, e);
        }
      })();
    },
  };
}
