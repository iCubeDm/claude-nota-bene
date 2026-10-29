import { isMediaAnchor, type AnchorSource, type Comment, type ImageRef } from '@nota-bene/shared';
import { mediaTypeOf } from '../attachments/image.ts';
import { getLang, t, tIn } from '../i18n/index.ts';
import { selectReplyLabel, sendMessage, type AppThunk } from '../store/store.ts';
import { composeBatch } from './compose.ts';
import { instructionOf, labelOf } from './labels.ts';
import { clearImages, draftSent, selectDraft, selectImages, selectUploading, setDraft, uploadFinished, uploadStarted } from '../composer/slice.ts';
import { markSending, selectPending } from './slice.ts';
import { selectFileVersion } from '../files/slice.ts';
import { mediaTime } from '../media/markup/geometry.ts';
import { activate } from '../tabs/slice.ts';
import { toast } from '../shell/toast.ts';
import { buildComposites, frameGroups } from './frameGroups.ts';

/** 'building': a combined image is being made and uploaded; the send finishes by itself (the button is disabled meanwhile). */
export type SendResult = 'empty' | 'sent' | 'offline' | 'switching' | 'building';

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
  // the batch text names a reply plainly: its number is the index in the CURRENT feed (restarts after a compaction, shifts when earlier history is shown); the quote is the locator
  return (st && selectReplyLabel(st, src.id, true)) ?? t('srcChat');
}

/**
 * The one send path: the composer draft plus every pending comment as one message. Pending → sent happens only via
 * the server echo; until then the ids sit in `sendingIds` so a second send cannot repeat them. On success the draft
 * and the composer images are cleared (comment images stay on their comments); when offline, everything is kept.
 * Images are numbered across the whole message: the composer's first, then each comment's in order. An upload still in
 * flight blocks the send ('empty': nothing happens, the button is disabled meanwhile). A send switches to the chat tab.
 * Media comments on one source frame share one composite image (`frameGroups`); `composites` maps group key → its attachment id,
 * a group without one (or whose comments changed meanwhile) falls back to each comment's own frame.
 */
const sendNow = (force: boolean, composites: Map<string, string>): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  // the server refuses sends mid-switch; the draft and the comments stay for the new session
  if (st.controls.switching) return 'switching';
  const pending = selectPending(st);
  const body = selectDraft(st).trim();
  const own = selectImages(st);
  if ((!body && !pending.length && !own.length) || selectUploading(st)) return 'empty';
  const lang = getLang();
  const images: ImageRef[] = own.map((im, k) => ({ ...im, label: tIn(lang, 'imgLabel', k + 1) }));
  const shared: ({ k: number; cs: number[] } | undefined)[] = [];
  const groupOf = new Map<number, { key: string; idx: number[] }>();
  for (const g of frameGroups(pending)) if (composites.has(g.key)) for (const i of g.idx) groupOf.set(i, g);
  const sharedK = new Map<string, number>(); // group key → its image number, once pushed
  const refs = pending.map((c, i) => {
    const g = groupOf.get(i);
    if (g) {
      let k = sharedK.get(g.key);
      if (k === undefined) {
        const cs = g.idx.map((j) => j + 1);
        const id = composites.get(g.key)!;
        images.push({ id, mediaType: mediaTypeOf(id), label: tIn(lang, 'imgLabelG', images.length + 1, cs) });
        k = images.length;
        sharedK.set(g.key, k);
      }
      shared[i] = { k, cs: g.idx.map((j) => j + 1) };
      return [k];
    }
    return mediaImages(c).map((id) => {
      images.push({ id, mediaType: mediaTypeOf(id), label: tIn(lang, 'imgLabelC', images.length + 1, i + 1) });
      return images.length;
    });
  });
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
    shared,
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

/**
 * Entry point. With comments sharing a source frame (and a live connection) the composite images are built and
 * uploaded first: the upload counter is raised for the duration (the send buttons are disabled, a second call is
 * 'empty'), then `sendNow` re-reads the whole state, so edits made meanwhile are honoured. A failed build toasts and
 * sends nothing; every comment and the draft stay.
 */
export const sendBatch = (force: boolean): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  const pending = selectPending(st);
  const groups = frameGroups(pending);
  if (!groups.length || st.controls.switching || selectUploading(st) || st.conn.state !== 'open') return d(sendNow(force, new Map()));
  d(uploadStarted());
  void buildComposites(pending, groups).then(
    (c) => { d(uploadFinished()); if (d(sendNow(force, c)) === 'offline') toast(t('offline'), ''); },
    (e) => { d(uploadFinished()); console.warn('composite image:', e); toast(t('groupFail'), ''); },
  );
  return 'building';
};
