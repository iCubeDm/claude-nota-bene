import type { ImageRef } from '@nota-bene/shared';
import { mediaTypeOf } from '../attachments/image.ts';
import { getLang, t, tIn } from '../i18n/index.ts';
import { selectReplyLabel, sendMessage, type AppThunk } from '../store/store.ts';
import { composeBatch } from './compose.ts';
import { instructionOf, labelOf } from './labels.ts';
import { clearImages, selectDraft, selectImages, selectUploading, setDraft } from '../composer/slice.ts';
import { markSending, selectPending } from './slice.ts';

export type SendResult = 'empty' | 'sent' | 'offline';

/**
 * The one send path: the composer draft plus every pending comment as one message. Pending → sent happens only via
 * the server echo; until then the ids sit in `sendingIds` so a second send cannot repeat them. On success the draft
 * and the composer images are cleared (comment images stay on their comments); when offline, everything is kept.
 * Images are numbered across the whole message: the composer's first, then each comment's in order. An upload still in
 * flight blocks the send ('empty': nothing happens, the button is disabled meanwhile).
 */
export const sendBatch = (force: boolean): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  const pending = selectPending(st);
  const body = selectDraft(st).trim();
  const own = selectImages(st);
  if ((!body && !pending.length && !own.length) || selectUploading(st)) return 'empty';
  const lang = getLang();
  const images: ImageRef[] = own.map((im, k) => ({ ...im, label: tIn(lang, 'imgLabel', k + 1) }));
  const refs = pending.map((c, i) => (c.images ?? []).map((id) => {
    images.push({ id, mediaType: mediaTypeOf(id), label: tIn(lang, 'imgLabelC', images.length + 1, i + 1) });
    return images.length;
  }));
  const text = composeBatch(
    body, pending, lang, (c) => labelOf(c, lang),
    (c) => (c.anchor.source.kind === 'message' ? (selectReplyLabel(st, c.anchor.source.id) ?? t('srcChat')) : c.anchor.source.path),
    instructionOf, refs,
  );
  const ids = pending.map((c) => c.id);
  if (!d(sendMessage(text, force, ids, images))) return 'offline';
  d(markSending(ids));
  d(setDraft(''));
  d(clearImages());
  return 'sent';
};
