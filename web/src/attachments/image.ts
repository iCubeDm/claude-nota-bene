import { IMAGE_TYPES, type ImageType } from '@nota-bene/shared';
import { apiFetch } from '@/net/auth.ts';

// Values copied from the prototype: the model works at <=1568 px on the long edge anyway, and the API caps an image at 5 MB.
export const IMG_OK: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMG_EDGE = 1568;
export const IMG_BYTES = 3.5e6;

/** media types of the ids uploaded in this page's lifetime; a comment stores bare ids, the server has the final say at send */
const known = new Map<string, ImageType>();
export const mediaTypeOf = (id: string): ImageType => known.get(id) ?? 'image/png';

const isImageType = (t: string): t is ImageType => (IMAGE_TYPES as readonly string[]).includes(t);

export async function encode(c: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  const blob = 'convertToBlob' in c
    ? await c.convertToBlob({ type, quality })
    : await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, type, quality));
  if (!blob) throw new Error('could not encode the image');
  return blob;
}

/**
 * Prototype `readImage` without base64: downscale to IMG_EDGE and re-encode when too big or in a format the API
 * does not take (heic, tiff…); small gif/webp/png/jpeg stay as they are. Png first (screenshots stay sharp), jpeg 0.9 when png is heavy.
 */
export async function prepareImage(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  try {
    const scale = Math.min(1, IMG_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= IMG_BYTES && IMG_OK.includes(file.type)) return file;
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    let c: OffscreenCanvas | HTMLCanvasElement;
    if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
    else {
      c = document.createElement('canvas');
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('no 2d canvas');
    ctx.drawImage(bmp, 0, 0, w, h);
    let blob = await encode(c, 'image/png');
    if (blob.size > IMG_BYTES) blob = await encode(c, 'image/jpeg', 0.9);
    return blob;
  } finally {
    bmp.close();
  }
}

/** POST /attach with the raw bytes; the id is the content hash, so the same image twice is one attachment. */
export async function uploadImage(b: Blob): Promise<{ id: string; mediaType: ImageType }> {
  const r = await apiFetch('/attach', { method: 'POST', headers: { 'content-type': b.type }, body: b });
  if (!r.ok) throw new Error(`attach ${r.status}`);
  const j = (await r.json()) as { id?: unknown; mediaType?: unknown };
  if (typeof j.id !== 'string' || typeof j.mediaType !== 'string' || !isImageType(j.mediaType)) throw new Error('bad attach reply');
  known.set(j.id, j.mediaType);
  return { id: j.id, mediaType: j.mediaType };
}
