import { afterEach, expect, it, vi } from 'vitest';
import { prepareImage, uploadImage } from './image.ts';

afterEach(() => vi.unstubAllGlobals());

/** createImageBitmap + OffscreenCanvas stubbed: the canvas records its size and the encodings asked for. */
function stubCanvas(bmp: { width: number; height: number }, sizes: Record<string, number> = {}) {
  const made: { w: number; h: number; types: string[] }[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ ...bmp, close() {} })));
  vi.stubGlobal('OffscreenCanvas', class {
    rec: { w: number; h: number; types: string[] };
    constructor(width: number, height: number) { this.rec = { w: width, h: height, types: [] }; made.push(this.rec); }
    getContext() { return { drawImage() {} }; }
    async convertToBlob({ type }: { type: string }) {
      this.rec.types.push(type);
      return new Blob([new Uint8Array(sizes[type] ?? 10)], { type });
    }
  });
  return made;
}

it('downsizes a 4000x1000 image to 1568 on the long edge and re-encodes as png', async () => {
  const made = stubCanvas({ width: 4000, height: 1000 });
  const out = await prepareImage(new File([new Uint8Array(100)], 'a.png', { type: 'image/png' }));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ w: 1568, h: 392, types: ['image/png'] });
  expect(out.type).toBe('image/png');
});

it('a heic file is re-encoded', async () => {
  const made = stubCanvas({ width: 800, height: 600 });
  const out = await prepareImage(new File([new Uint8Array(100)], 'a.heic', { type: 'image/heic' }));
  expect(made[0]).toMatchObject({ w: 800, h: 600 });
  expect(out.type).toBe('image/png');
});

it('png over the byte limit falls back to jpeg 0.9', async () => {
  const made = stubCanvas({ width: 800, height: 600 }, { 'image/png': 4e6 });
  const out = await prepareImage(new File([new Uint8Array(100)], 'a.bmp', { type: 'image/bmp' }));
  expect(made[0]!.types).toEqual(['image/png', 'image/jpeg']);
  expect(out.type).toBe('image/jpeg');
});

it('a small gif or webp stays as it is', async () => {
  const made = stubCanvas({ width: 800, height: 600 });
  const f = new File([new Uint8Array(100)], 'a.gif', { type: 'image/gif' });
  expect(await prepareImage(f)).toBe(f);
  expect(made).toHaveLength(0);
});

it('uploadImage posts the raw bytes with their type and returns the id', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'a'.repeat(64), mediaType: 'image/png' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const blob = new Blob(['x'], { type: 'image/png' });
  await expect(uploadImage(blob)).resolves.toEqual({ id: 'a'.repeat(64), mediaType: 'image/png' });
  expect(fetchMock).toHaveBeenCalledWith('/attach', { method: 'POST', headers: { 'content-type': 'image/png' }, body: blob });
});

it('uploadImage rejects on a non-2xx', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('too big', { status: 413 })));
  await expect(uploadImage(new Blob(['x'], { type: 'image/png' }))).rejects.toThrow();
});
