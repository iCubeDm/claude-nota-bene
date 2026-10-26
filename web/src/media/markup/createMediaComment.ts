import type { MediaAnchor } from '@nota-bene/shared';
import { prepareImage, uploadImage } from '@/attachments/image.ts';
import { t } from '@/i18n/index.ts';
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

/** What only prepare knows for sure; merged into the anchor before the comment is added. */
export type MediaAnchorPatch = Partial<Pick<MediaAnchor, 'scale' | 'version' | 'time'>>;

/** A HEAD that never answers must not hold Add forever: no version then. */
const VERSION_WAIT_MS = 5000;
/** How long a video may take to have its current frame (loading, or mid-seek) before Add gives up with an error. */
const FRAME_WAIT_MS = 5000;

/** Resolves once the video has the frame at its current time (not seeking, readyState >= HAVE_CURRENT_DATA). */
function frameReady(v: HTMLVideoElement): Promise<void> {
  const ready = () => v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !v.seeking;
  if (ready()) return Promise.resolve();
  const events = ['loadeddata', 'seeked', 'canplay', 'timeupdate'] as const;
  return new Promise((resolve, reject) => {
    const done = (e?: Error) => {
      clearTimeout(timer);
      for (const n of events) v.removeEventListener(n, check);
      if (e) reject(e);
      else resolve();
    };
    const check = () => void (ready() && done());
    const timer = setTimeout(() => done(new Error(t('markNoFrame'))), FRAME_WAIT_MS);
    for (const n of events) v.addEventListener(n, check);
  });
}

/**
 * Renders, uploads the natural-size files to /marks/<id>/…, uploads downscaled copies to /attach; returns the ids
 * (frame first) and the anchor patch. On any failure deletes /marks/<id> and rejects. Sequential on purpose: a DELETE
 * after a failure must not overtake a write still in flight.
 * - A video is paused, waited for until it has the current frame (FRAME_WAIT_MS, then an error), and its time read
 *   right before the frame is drawn (an OS media key may have resumed it).
 * - `version`: the media's ETag request, made when the mode was entered; awaited here, after the frame is captured.
 * - `scale`: only when the files had to be downscaled to fit (< 1).
 */
export async function prepareMediaComment(
  id: string, source: CanvasImageSource, anchor: MediaAnchor, o: { version?: Promise<string | undefined> } = {},
): Promise<{ images: string[]; anchor: MediaAnchorPatch }> {
  try {
    const patch: MediaAnchorPatch = {};
    if (source instanceof HTMLVideoElement) {
      source.pause();
      await frameReady(source); // an empty or mid-seek video would draw a blank (or a stale) frame
      source.pause(); // again: a media key may have resumed it during the wait
      patch.time = Math.round(source.currentTime * 1000) / 1000;
    }
    // no await between the time and the call: renderMarks draws the frame before its first await
    const { frame, layer, scale } = await renderMarks(source, anchor.width, anchor.height, anchor.shapes);
    if (scale < 1) patch.scale = scale;
    await putMark(id, 'frame.jpg', frame);
    await putMark(id, 'layer.png', layer);
    const f = await uploadImage(await prepareImage(frame));
    const l = await uploadImage(await prepareImage(layer));
    if (o.version) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const version = await Promise.race([
        o.version.catch(() => undefined),
        new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), VERSION_WAIT_MS))),
      ]);
      clearTimeout(timer);
      if (version !== undefined) patch.version = version;
    }
    return { images: [f.id, l.id], anchor: patch };
  } catch (e) {
    await deleteMarks(id);
    throw e;
  }
}
