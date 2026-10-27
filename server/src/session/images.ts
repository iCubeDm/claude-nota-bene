import type { ImageRef } from '@nota-bene/shared';
import type { SendImage } from '../agent/types.ts';
import type { AttachmentStore } from '../attachments.ts';

/** A send's image refs resolved: an unknown id is reported and dropped, the text and the other images still go out. */
export function resolveImages(store: AttachmentStore, images: ImageRef[] | undefined, onError: (e: unknown) => void): { refs: ImageRef[]; payload: SendImage[] } {
  const refs: ImageRef[] = [];
  const payload: SendImage[] = [];
  for (const ref of images ?? []) {
    try {
      const found = store.get(ref.id);
      if (!found) throw new Error(`unknown attachment ${ref.id}`);
      refs.push({ ...ref, mediaType: found.mediaType });
      payload.push({ mediaType: found.mediaType, data: found.bytes.toString('base64'), label: ref.label });
    } catch (e) {
      onError(e);
    }
  }
  return { refs, payload };
}
