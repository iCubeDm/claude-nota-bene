import type { RequestListener, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
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

const PREFIX_ROUTES = ['/attach/', '/marks/'];

export function isAllowedHost(host: string | undefined, allowed: readonly string[]): boolean {
  return host !== undefined && allowed.includes(host.toLowerCase());
}

export function httpHandler(o: {
  hub: EventHub;
  webDist: string;
  info: () => object;
  allowedHosts: string[]; // read per request, so the caller may fill it after listen()
  allowedOrigins?: string[]; // same; any method other than GET/HEAD needs an Origin from this list
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
    pipeline(fs.createReadStream(file), res, (e) => {
      if (e && (e as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') reportError(o.hub, req.url ?? '', e);
    });
  }

  return (req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, o.allowedHosts)) {
        text(res, 403, 'forbidden host');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.headers.origin !== undefined && (o.allowedOrigins ?? []).includes(req.headers.origin))) {
        text(res, 403, 'forbidden origin');
        return;
      }
      const raw = req.url ?? '/';
      const qi = raw.indexOf('?');
      const rawPath = qi === -1 ? raw : raw.slice(0, qi);

      // /attach/<id> and /marks/<id>[/<name>] are dynamic: matched by prefix
      const prefix = PREFIX_ROUTES.find((p) => rawPath.startsWith(p));
      const route = o.extra?.[prefix ?? rawPath];
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
