import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';

let dist: string;
let server: http.Server;
let port: number;
const hub = new EventHub();
const allowedHosts: string[] = [];

beforeAll(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-http-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>index</h1>');
  fs.writeFileSync(path.join(dist, 'a.js'), 'console.log(1)');
  server = http.createServer(
    httpHandler({
      hub,
      webDist: dist,
      allowedHosts,
      info: () => ({ name: 'nb' }),
      extra: {
        '/boom': () => {
          throw new Error('kaboom');
        },
      },
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dist, { recursive: true, force: true });
});

// raw request so the path is not normalised by fetch
function raw(method: string, p: string, headers?: Record<string, string>): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, method, path: p, ...(headers ? { headers } : {}) }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
      })
      .on('error', reject)
      .end();
  });
}

describe('httpHandler', () => {
  it('/info returns json', async () => {
    const r = await raw('GET', '/info');
    expect(r.status).toBe(200);
    expect(r.type).toContain('application/json');
    expect(JSON.parse(r.body)).toEqual({ name: 'nb' });
  });

  it('serves a static file with its content type', async () => {
    const r = await raw('GET', '/a.js');
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/javascript');
    expect(r.body).toBe('console.log(1)');
  });

  it('unknown path falls back to index.html', async () => {
    const r = await raw('GET', '/some/route');
    expect(r.status).toBe(200);
    expect(r.type).toContain('text/html');
    expect(r.body).toBe('<h1>index</h1>');
  });

  it('path traversal is 403', async () => {
    expect((await raw('GET', '/../secret')).status).toBe(403);
    expect((await raw('GET', '/%2e%2e/secret')).status).toBe(403);
    expect((await raw('GET', '/%2e%2e%2f%2e%2e%2fetc/passwd')).status).toBe(403);
  });

  it('a throwing route becomes 500 with its message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const emit = vi.spyOn(hub, 'emit');
    const r = await raw('GET', '/boom');
    expect(r.status).toBe(500);
    expect(r.type).toContain('text/plain');
    expect(r.body).toBe('kaboom');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'server-error', message: 'kaboom' }), { store: false });
    spy.mockRestore();
    emit.mockRestore();
  });

  it('non-GET is 405', async () => {
    expect((await raw('POST', '/info')).status).toBe(405);
    expect((await raw('POST', '/a.js')).status).toBe(405);
  });
});
