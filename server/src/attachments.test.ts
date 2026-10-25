import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore, attachmentRoutes } from './attachments.ts';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-att-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('AttachmentStore', () => {
  it('same bytes twice: same id, one file', () => {
    const s = new AttachmentStore({ dir });
    const a = s.put(Buffer.from('abc'), 'image/png');
    const b = s.put(Buffer.from('abc'), 'image/png');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readdirSync(dir)).toEqual([`${a}.png`]);
    expect(s.get(a)).toEqual({ bytes: Buffer.from('abc'), mediaType: 'image/png' });
  });

  it('the same bytes under another type reuse the first file', () => {
    const s = new AttachmentStore({ dir });
    const a = s.put(Buffer.from('abc'), 'image/png');
    expect(s.put(Buffer.from('abc'), 'image/jpeg')).toBe(a);
    expect(fs.readdirSync(dir)).toEqual([`${a}.png`]);
    expect(s.get(a)?.mediaType).toBe('image/png');
  });

  it('get rethrows disk errors other than ENOENT', () => {
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    expect(() => new AttachmentStore({ dir: path.join(dir, 'file') }).get('a'.repeat(64))).toThrow();
  });

  it('rejects ids that are not 64 hex chars, even when the target exists outside the store', () => {
    const s = new AttachmentStore({ dir: path.join(dir, 'store') });
    fs.writeFileSync(path.join(dir, 'secret.png'), 'secret');
    expect(s.get('../secret')).toBeNull();
    expect(s.get('../../etc')).toBeNull();
    expect(s.get('a'.repeat(64))).toBeNull(); // valid shape, absent
  });
});

describe('attachment routes', () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    const hosts: string[] = [];
    const origins: string[] = [];
    const hub = new EventHub();
    server = http.createServer(httpHandler({
      hub, webDist: dir, info: () => ({}), allowedHosts: hosts, allowedOrigins: origins,
      extra: attachmentRoutes(new AttachmentStore({ dir: path.join(dir, 'a') }), hub),
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    hosts.push(`127.0.0.1:${port}`);
    origins.push(base);
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const post = (body: Buffer, type: string) =>
    fetch(`${base}/attach`, { method: 'POST', headers: { 'content-type': type, origin: base }, body: new Uint8Array(body) });

  it('stores a png and serves it back with immutable caching', async () => {
    const r = await post(Buffer.from('png-bytes'), 'image/png');
    expect(r.status).toBe(200);
    const { id, mediaType } = (await r.json()) as { id: string; mediaType: string };
    expect(mediaType).toBe('image/png');
    const g = await fetch(`${base}/attach/${id}`);
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toBe('image/png');
    expect(g.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(g.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await g.arrayBuffer()).toString()).toBe('png-bytes');
  });

  it('413 for a 6 MB body', async () => {
    const r = await post(Buffer.alloc(6 * 1024 * 1024, 1), 'image/png');
    expect(r.status).toBe(413);
  });

  it('413 for a chunked over-cap body without content-length', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let n = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (n++ < 6) c.enqueue(chunk); else c.close(); } });
    const r = await fetch(`${base}/attach`, {
      method: 'POST', headers: { 'content-type': 'image/png', origin: base }, body, duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(413);
  });

  it('a disk error gives 500 and the server keeps serving', async () => {
    fs.writeFileSync(path.join(dir, 'a'), 'a regular file where the store dir should be');
    expect((await post(Buffer.from('x'), 'image/png')).status).toBe(500);
    expect((await fetch(`${base}/attach/${'0'.repeat(64)}`)).status).toBe(500); // ENOTDIR, not ENOENT
    expect((await post(Buffer.from('x'), 'image/heic')).status).toBe(415);
  });

  it('415 for image/heic', async () => {
    expect((await post(Buffer.from('x'), 'image/heic')).status).toBe(415);
  });

  it('404 for an unknown or malformed id', async () => {
    expect((await fetch(`${base}/attach/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${base}/attach/..%2F..%2Fetc`)).status).toBe(404);
  });

  it('403 without an allowed Origin', async () => {
    const r = await fetch(`${base}/attach`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(1) });
    expect(r.status).toBe(403);
  });
});
