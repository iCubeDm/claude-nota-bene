import type { MediaAnchor } from '@nota-bene/shared';
import { prepareImage, uploadImage } from '@/attachments/image.ts';
import { renderMarks } from './render.ts';

async function putMark(id: string, name: 'frame.jpg' | 'layer.png', b: Blob): Promise<void> {
  const type = name === 'frame.jpg' ? 'image/jpeg' : 'image/png';
  const r = await fetch(`/marks/${id}/${name}`, { method: 'POST', headers: { 'content-type': type }, body: b });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
}

/**
 * Drops `/marks/<id>` (the comment never came to be). Never throws: a 409 means the comment is already sent and keeps
 * its files; a network error leaves an orphan folder, which is logged, not shown (the server's sweep is later work).
 */
export async function deleteMarks(id: string): Promise<void> {
  try {
    const r = await fetch(`/marks/${id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 409) console.warn(`DELETE /marks/${id}: ${r.status}`);
  } catch (e) {
    console.warn(`DELETE /marks/${id}:`, e);
  }
}

/**
 * Renders, uploads the natural-size files to /marks/<id>/…, uploads downscaled copies to /attach; returns the ids
 * (frame first). On any failure deletes /marks/<id> and rejects. Sequential on purpose: a DELETE after a failure must
 * not overtake a write still in flight.
 */
export async function prepareMediaComment(id: string, source: CanvasImageSource, anchor: MediaAnchor): Promise<{ images: string[] }> {
  try {
    const { frame, layer } = await renderMarks(source, anchor.width, anchor.height, anchor.shapes);
    await putMark(id, 'frame.jpg', frame);
    await putMark(id, 'layer.png', layer);
    const f = await uploadImage(await prepareImage(frame));
    const l = await uploadImage(await prepareImage(layer));
    return { images: [f.id, l.id] };
  } catch (e) {
    await deleteMarks(id);
    throw e;
  }
}
