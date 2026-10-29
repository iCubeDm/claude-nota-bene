import { isMediaAnchor, type AnchorSource, type Comment, type ImageRef } from '@nota-bene/shared';
import { mediaTypeOf } from '../attachments/image.ts';
import { getLang, t, tIn } from '../i18n/index.ts';
import { selectReplyLabel, sendMessage, type AppThunk } from '../store/store.ts';
import { composeBatch } from './compose.ts';
import { instructionOf, labelOf } from './labels.ts';
import { clearImages, draftSent, selectDraft, selectImages, selectUploading, setDraft } from '../composer/slice.ts';
import { markSending, selectPending } from './slice.ts';
import { selectFileVersion } from '../files/slice.ts';
import { mediaTime } from '../media/markup/geometry.ts';
import { activate } from '../tabs/slice.ts';

export type SendResult = 'empty' | 'sent' | 'offline' | 'switching';

/** A file source as the batch and the card name it: `path`, or `path @ ref` for another branch or worktree (M3-16). */
export const whereOfFile = (src: Extract<AnchorSource, { kind: 'file' }>): string => (src.ref ? `${src.path} @ ${src.ref}` : src.path);

/** A media comment sends its frame only (images[0]); old comments stored layer.png as a second id, which stays on disk. */
const mediaImages = (c: Comment): string[] => (isMediaAnchor(c.anchor) ? (c.images ?? []).slice(0, 1) : c.images ?? []);

/** Where a comment's fragment lives, for the batch line: the reply label, "my message", or the file. */
export function whereOf(c: Comment, st?: Parameters<typeof selectReplyLabel>[0]): string {
  const src = c.anchor.source;
  const a = c.anchor;
  if (isMediaAnchor(a)) return `${whereOfFile(a.source)}${a.time !== undefined ? ` @ ${mediaTime(a.time)}` : ''} · ${a.width}×${a.height}`;
  if (src.kind === 'file') return whereOfFile(src);
  return (st && selectReplyLabel(st, src.id)) ?? t('srcChat');
}

/**
 * The one send path: the composer draft plus every pending comment as one message. Pending → sent happens only via
 * the server echo; until then the ids sit in `sendingIds` so a second send cannot repeat them. On success the draft
 * and the composer images are cleared (comment images stay on their comments); when offline, everything is kept.
 * Images are numbered across the whole message: the composer's first, then each comment's in order. An upload still in
 * flight blocks the send ('empty': nothing happens, the button is disabled meanwhile). A send switches to the chat tab.
 */
export const sendBatch = (force: boolean): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  // the server refuses sends mid-switch; the draft and the comments stay for the new session
  if (st.controls.switching) return 'switching';
  const pending = selectPending(st);
  const body = selectDraft(st).trim();
  const own = selectImages(st);
  if ((!body && !pending.length && !own.length) || selectUploading(st)) return 'empty';
  const lang = getLang();
  const images: ImageRef[] = own.map((im, k) => ({ ...im, label: tIn(lang, 'imgLabel', k + 1) }));
  const refs = pending.map((c, i) => mediaImages(c).map((id) => {
    images.push({ id, mediaType: mediaTypeOf(id), label: tIn(lang, 'imgLabelC', images.length + 1, i + 1) });
    return images.length;
  }));
  const text = composeBatch(
    body, pending, lang, (c) => labelOf(c, lang),
    (c) => whereOf(c, st),
    instructionOf, refs,
    // "changed": only when the current version is known (a tab has it loaded) and differs from the one drawn on
    (c) => {
      const a = c.anchor;
      if (!isMediaAnchor(a) || a.version === undefined) return false;
      const cur = selectFileVersion(st, a.source.path, a.source.ref);
      return cur !== undefined && cur !== a.version;
    },
  );
  const ids = pending.map((c) => c.id);
  const id = crypto.randomUUID();
  if (!d(sendMessage(text, force, ids, images, id))) return 'offline';
  d(draftSent({ id, text: body, images: own, commentIds: ids })); // until the echo: a refusal puts it back
  d(markSending(ids));
  d(setDraft(''));
  d(clearImages());
  d(activate('chat')); // sent from a file tab: the reply arrives in the chat (prototype parity)
  return 'sent';
};
