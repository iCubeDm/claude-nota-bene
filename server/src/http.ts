import type { RequestListener, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { EventHub } from './hub.ts';
import { reportError } from './errors.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function statFile(p: string): fs.Stats | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

export function httpHandler(o: {
  hub: EventHub;
  webDist: string;
  info: () => object;
  extra?: Record<string, RequestListener>;
}): RequestListener {
  const root = path.resolve(o.webDist);

  function sendFile(req: Parameters<RequestListener>[0], res: ServerResponse, file: string, size: number): void {
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file);
    stream.on('error', (e) => {
      reportError(o.hub, req.url ?? '', e);
      stream.destroy();
      res.destroy();
    });
    stream.pipe(res);
  }

  return (req, res) => {
    try {
      const raw = req.url ?? '/';
      const qi = raw.indexOf('?');
      const rawPath = qi === -1 ? raw : raw.slice(0, qi);

      const route = o.extra?.[rawPath];
      if (route) {
        route(req, res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        text(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
        return;
      }

      if (rawPath === '/info') {
        const body = JSON.stringify(o.info());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      let decoded: string;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        text(res, 400, 'bad request');
        return;
      }
      if (decoded.includes('\0')) {
        text(res, 400, 'bad request');
        return;
      }
      const resolved = path.resolve(root, '.' + path.sep + decoded);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        text(res, 403, 'forbidden');
        return;
      }

      const st = statFile(resolved);
      if (st) {
        sendFile(req, res, resolved, st.size);
        return;
      }
      const index = path.join(root, 'index.html');
      const ist = statFile(index);
      if (ist) {
        sendFile(req, res, index, ist.size);
        return;
      }
      text(res, 404, 'not found');
    } catch (e) {
      reportError(o.hub, req.url ?? '', e);
      if (!res.headersSent) text(res, 500, e instanceof Error ? e.message : String(e));
      else res.destroy();
    }
  };
}
