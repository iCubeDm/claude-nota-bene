// Images the agent leaves in a temp folder (a screenshot in /tmp) open in a tab like project files. This is the one place the
// server reads outside the project, so it is deliberately narrow: GET/HEAD of one regular image file, nothing else. No listing,
// no search, no Range, and it is not a cookie route (auth.ts cookieRoute): the page loads it through apiFetch into a blob.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { underState } from './stateGuard.ts';

export const TMP_IMAGE_MAX = 50 * 1024 * 1024;

export const TMP_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
const typeOf = (file: string): string | undefined => TMP_IMAGE_TYPES[path.extname(file).toLowerCase()];

/** The temp folders as real paths: `os.tmpdir()`, `/tmp` and `/private/tmp` (those that exist), without duplicates. */
export function tmpDirs(): string[] {
  const out = new Set<string>();
  for (const d of [os.tmpdir(), '/tmp', '/private/tmp']) {
    try {
      out.add(fs.realpathSync.native(d));
    } catch { /* not on this machine */ }
  }
  return [...out];
}

const SAFETY = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

export type TmpImage = { handle: fs.promises.FileHandle; size: number; type: string; mtimeMs: number };

/**
 * Opens `p` when it is an image of a temp folder, else null (a missing file, a path outside, a non-image: the caller answers
 * all of them alike). null | 'big' for a file over the cap. Order: the extension of the path asked for, its real path, that
 * real path inside a temp folder (never the folder itself), outside the state folder, with an image extension of its own;
 * then the file is opened without blocking (a FIFO named x.png cannot hang) and the opened descriptor must be a regular file.
 */
export async function openTmpImage(p: string): Promise<TmpImage | 'big' | null> {
  if (!p || p.includes('\0') || !path.isAbsolute(p) || !typeOf(p)) return null;
  let real: string;
  try {
    real = await fs.promises.realpath(p);
  } catch {
    return null;
  }
  const type = typeOf(real);
  if (!type || !tmpDirs().some((d) => real.startsWith(d + path.sep))) return null;
  if (underState(p) || underState(real)) return null;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > TMP_IMAGE_MAX) {
      await handle.close();
      return 'big';
    }
    return { handle, size: st.size, type, mtimeMs: st.mtimeMs };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

/** The route body: `/tmpimage?path=<absolute path>`. 404 is one body for everything that is not served. */
export function serveTmpImage(
  req: { method?: string; url?: string },
  res: import('node:http').ServerResponse,
  onError: (e: unknown) => void,
): void {
  const plain = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  };
  const p = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '';
  openTmpImage(p).then((img) => {
    if (img === 'big') return plain(413, 'too large');
    if (!img) return plain(404, 'not found');
    res.writeHead(200, { 'content-type': img.type, 'content-length': img.size, etag: `W/"${img.size}-${img.mtimeMs}"`, ...SAFETY });
    if (req.method === 'HEAD') {
      img.handle.close().catch(() => {});
      res.end();
      return;
    }
    // the descriptor that was checked is the one read; pipeline closes it when the client leaves
    pipeline(img.handle.createReadStream({ end: Math.max(0, img.size - 1), start: 0 }), res, (e) => {
      if (e && (e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') onError(e);
    });
  }, onError);
}
