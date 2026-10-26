import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaAnchor } from '@nota-bene/shared';

const frame = new Blob([new Uint8Array(30)], { type: 'image/jpeg' });
const layer = new Blob([new Uint8Array(20)], { type: 'image/png' });
const small = { jpeg: new Blob([new Uint8Array(3)], { type: 'image/jpeg' }), png: new Blob([new Uint8Array(2)], { type: 'image/png' }) };
const renderMarks = vi.fn(async () => ({ frame, layer, scale: 1 }));
vi.mock('./render.ts', () => ({ renderMarks: (...a: unknown[]) => renderMarks(...(a as [])) }));
// the downscaled copy: a distinct blob, so the test sees which body went where
vi.mock('@/attachments/image.ts', async (orig) => ({
  ...(await orig<typeof import('@/attachments/image.ts')>()),
  prepareImage: vi.fn(async (b: Blob) => (b.type === 'image/jpeg' ? small.jpeg : small.png)),
}));

const { prepareMediaComment, deleteMarks } = await import('./createMediaComment.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const anchor: MediaAnchor = {
  kind: 'media', source: { kind: 'file', path: 'media/a.png' }, width: 1000, height: 500,
  shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
};
const src = {} as CanvasImageSource;

type Call = { url: string; method: string; type?: string; body?: unknown };
let calls: Call[];
let fail: (c: Call) => Response | null;
beforeEach(() => {
  calls = [];
  fail = () => null;
  renderMarks.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? 'GET', type: (init.headers as Record<string, string> | undefined)?.['content-type'], body: init.body };
    calls.push(c);
    const f = fail(c);
    if (f) return f;
    if (url === '/attach') return Response.json({ id: c.body === small.jpeg ? 'f'.repeat(64) : 'a'.repeat(64), mediaType: c.type });
    return new Response(null, { status: 204 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

it('prepare uploads frame and layer to /marks/<id>/ and both copies to /attach, frame first', async () => {
  const out = await prepareMediaComment(ID, src, anchor);
  expect(renderMarks).toHaveBeenCalledWith(src, 1000, 500, anchor.shapes);
  expect(calls.map((c) => `${c.method} ${c.url} ${c.type}`)).toEqual([
    `POST /marks/${ID}/frame.jpg image/jpeg`,
    `POST /marks/${ID}/layer.png image/png`,
    'POST /attach image/jpeg',
    'POST /attach image/png',
  ]);
  // the project files are the natural-size renders, the attachments the downscaled copies
  expect(calls.map((c) => c.body)).toEqual([frame, layer, small.jpeg, small.png]);
  expect(out).toEqual({ images: ['f'.repeat(64), 'a'.repeat(64)] });
});

it('a failed upload deletes /marks/<id> and rejects', async () => {
  fail = (c) => (c.url === '/attach' ? new Response('no', { status: 500 }) : null);
  await expect(prepareMediaComment(ID, src, anchor)).rejects.toThrow();
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: `/marks/${ID}` });
});

it('a failed mark write deletes /marks/<id> and rejects, nothing goes to /attach', async () => {
  fail = (c) => (c.url.endsWith('layer.png') ? new Response('full', { status: 500 }) : null);
  await expect(prepareMediaComment(ID, src, anchor)).rejects.toThrow(/layer\.png 500/);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    `POST /marks/${ID}/frame.jpg`, `POST /marks/${ID}/layer.png`, `DELETE /marks/${ID}`,
  ]);
});

it('a failed render deletes /marks/<id> and rejects', async () => {
  renderMarks.mockRejectedValueOnce(new Error('tainted canvas'));
  await expect(prepareMediaComment(ID, src, anchor)).rejects.toThrow('tainted canvas');
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE /marks/${ID}`]);
});

it('deleteMarks: a 409 (already sent) and a network error are both quiet', async () => {
  fail = () => new Response('sent', { status: 409 });
  await expect(deleteMarks(ID)).resolves.toBeUndefined();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(deleteMarks(ID)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});
