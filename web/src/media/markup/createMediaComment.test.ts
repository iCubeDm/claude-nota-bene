import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MediaAnchor } from '@nota-bene/shared';

const frame = new Blob([new Uint8Array(30)], { type: 'image/jpeg' });
const layer = new Blob([new Uint8Array(20)], { type: 'image/png' });
const small = { jpeg: new Blob([new Uint8Array(3)], { type: 'image/jpeg' }), png: new Blob([new Uint8Array(2)], { type: 'image/png' }) };
const renderMarks = vi.fn(async (..._a: unknown[]) => ({ frame, layer, scale: 1 }));
vi.mock('./render.ts', () => ({ renderMarks: (...a: unknown[]) => renderMarks(...a) }));
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

it('prepare uploads frame and layer to /marks/<id>/ and only the frame copy to /attach', async () => {
  const out = await prepareMediaComment(ID, src, anchor);
  expect(renderMarks).toHaveBeenCalledWith(src, 1000, 500, anchor.shapes);
  expect(calls.map((c) => `${c.method} ${c.url} ${c.type}`)).toEqual([
    `POST /marks/${ID}/frame.jpg image/jpeg`,
    `POST /marks/${ID}/layer.png image/png`,
    'POST /attach image/jpeg',
  ]);
  // the project files are the natural-size renders, the attachments the downscaled copies
  expect(calls.map((c) => c.body)).toEqual([frame, layer, small.jpeg]);
  expect(out).toEqual({ images: ['f'.repeat(64)], anchor: {} }); // unscaled, no video, no version
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

it('a downscaled render puts its scale on the anchor patch; scale 1 adds no field', async () => {
  renderMarks.mockResolvedValueOnce({ frame, layer, scale: 0.75 });
  expect((await prepareMediaComment(ID, src, anchor)).anchor).toEqual({ scale: 0.75 });
  expect((await prepareMediaComment(ID, src, anchor)).anchor).not.toHaveProperty('scale');
});

it('the version is awaited inside prepare (a HEAD still in flight when Add was pressed)', async () => {
  let answer!: (v: string | undefined) => void;
  const version = new Promise<string | undefined>((r) => (answer = r));
  const p = prepareMediaComment(ID, src, anchor, { version });
  await new Promise((r) => setTimeout(r, 0));
  answer('W/"5-1"');
  expect((await p).anchor).toEqual({ version: 'W/"5-1"' });
});

it('a video is paused and its time read at the moment of the render', async () => {
  const v = document.createElement('video');
  let t = 4.2404;
  let playing = true;
  Object.defineProperty(v, 'currentTime', { get: () => t, set: (x: number) => void (t = x) });
  Object.defineProperty(v, 'paused', { get: () => !playing });
  Object.defineProperty(v, 'readyState', { get: () => 4 });
  v.pause = vi.fn(() => void (playing = false));
  const seen: { paused: boolean; time: number }[] = [];
  renderMarks.mockImplementationOnce(async () => {
    seen.push({ paused: v.paused, time: v.currentTime });
    t = 9; // whatever happens after the frame is drawn does not count
    return { frame, layer, scale: 1 };
  });
  t = 4.2406; // an OS media key resumed it after the drawing: the frame drawn is the one at this time
  const out = await prepareMediaComment(ID, v, { ...anchor, time: 1 });
  expect(seen).toEqual([{ paused: true, time: 4.2406 }]);
  expect(out.anchor).toEqual({ time: 4.241 });
});

/** A video whose readyState / seeking the test drives; events are fired by hand. */
function fakeVideo(o: { ready: number; seeking: boolean }) {
  const v = document.createElement('video');
  let t = 2;
  Object.defineProperty(v, 'currentTime', { get: () => t, set: (x: number) => void (t = x) });
  Object.defineProperty(v, 'readyState', { get: () => o.ready });
  Object.defineProperty(v, 'seeking', { get: () => o.seeking });
  v.pause = vi.fn();
  return { v, setTime: (x: number) => void (t = x) };
}

it('a video without the current frame (readyState < HAVE_CURRENT_DATA) is waited for until loadeddata, then drawn', async () => {
  const o = { ready: 1, seeking: false };
  const { v, setTime } = fakeVideo(o);
  const p = prepareMediaComment(ID, v, { ...anchor, time: 1 });
  await new Promise((r) => setTimeout(r, 0));
  expect(renderMarks).not.toHaveBeenCalled(); // nothing drawn from an empty video
  o.ready = 2;
  setTime(3.5);
  v.dispatchEvent(new Event('loadeddata'));
  const out = await p;
  expect(renderMarks).toHaveBeenCalledTimes(1);
  expect(out.anchor).toEqual({ time: 3.5 }); // the time is read once the frame is there
});

it('a seeking video is waited for until seeked', async () => {
  const o = { ready: 4, seeking: true };
  const { v } = fakeVideo(o);
  const p = prepareMediaComment(ID, v, anchor);
  await new Promise((r) => setTimeout(r, 0));
  expect(renderMarks).not.toHaveBeenCalled();
  o.seeking = false;
  v.dispatchEvent(new Event('seeked'));
  await p;
  expect(renderMarks).toHaveBeenCalledTimes(1);
});

it('a video frame that never arrives: an error (shown in the popup) after the timeout, nothing drawn or written', async () => {
  vi.useFakeTimers();
  try {
    const { v } = fakeVideo({ ready: 0, seeking: false });
    const p = prepareMediaComment(ID, v, anchor);
    const settled = expect(p).rejects.toThrow(/frame/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(renderMarks).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
