import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fakeBackend } from './agent/fake.ts';
import { startServer } from './server.ts';

let home: string;
let dist: string;
const prevHome = process.env.NOTA_BENE_HOME;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sec-home-'));
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sec-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>x</h1>');
  process.env.NOTA_BENE_HOME = home;
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  if (prevHome === undefined) delete process.env.NOTA_BENE_HOME; else process.env.NOTA_BENE_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

async function boot(allowedOrigins?: string[]) {
  const s = await startServer({ insecureNoAuth: true,
    cwd: '/proj', port: 0, backend: fakeBackend([]), webDist: dist,
    ...(allowedOrigins ? { allowedOrigins } : {}),
  });
  closers.push(s.close);
  return { ...s, port: Number(new URL(s.url).port) };
}

function get(port: number, p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    }).on('error', reject).end();
  });
}

// resolves with the first frame, or the HTTP status of a rejected upgrade
function wsTry(url: string, origin?: string): Promise<{ frame?: string; status?: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('http', 'ws'), origin ? { headers: { Origin: origin } } : {});
    closers.push(async () => { ws.terminate(); });
    ws.once('message', (d) => resolve({ frame: String(d) }));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode! }));
    ws.once('error', (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}

describe('host and origin checks', () => {
  it('http rejects a foreign Host', async () => {
    const s = await boot();
    expect(await get(s.port, '/info', { Host: 'evil.example:4777' })).toBe(403);
  });

  it('http accepts localhost Host', async () => {
    const s = await boot();
    expect(await get(s.port, '/info', { Host: `localhost:${s.port}` })).toBe(200);
    expect(await get(s.port, '/info', { Host: `LOCALHOST:${s.port}` })).toBe(200);
  });

  it('ws rejects a foreign Origin', async () => {
    const s = await boot();
    const r = await wsTry(s.url, 'https://evil.example');
    expect(r.status).toBe(403);
    expect(r.frame).toBeUndefined();
  });

  it('ws accepts no Origin and own Origin', async () => {
    const s = await boot();
    expect((await wsTry(s.url)).frame).toBeDefined();
    expect((await wsTry(s.url, `http://127.0.0.1:${s.port}`)).frame).toBeDefined();
    expect((await wsTry(s.url, `http://localhost:${s.port}`)).frame).toBeDefined();
  });

  it('ws accepts an allowedOrigins entry', async () => {
    const s = await boot(['http://localhost:5173']);
    expect((await wsTry(s.url, 'http://localhost:5173')).frame).toBeDefined();
  });
});
