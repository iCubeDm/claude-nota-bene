import { getLang, t } from '../i18n/index.ts';
import { selectReplyLabel, sendMessage, type AppThunk } from '../store/store.ts';
import { composeBatch } from './compose.ts';
import { instructionOf, labelOf } from './labels.ts';
import { selectDraft, setDraft } from '../composer/slice.ts';
import { markSending, selectPending } from './slice.ts';

export type SendResult = 'empty' | 'sent' | 'offline';

/**
 * The one send path: the composer draft plus every pending comment as one message. Pending → sent happens only via
 * the server echo; until then the ids sit in `sendingIds` so a second send cannot repeat them. On success the draft
 * is cleared; when offline, the draft and the comments are kept.
 */
export const sendBatch = (force: boolean): AppThunk<SendResult> => (d, getState) => {
  const st = getState();
  const pending = selectPending(st);
  const body = selectDraft(st).trim();
  if (!body && !pending.length) return 'empty';
  const lang = getLang();
  const text = composeBatch(
    body, pending, lang, (c) => labelOf(c, lang),
    (c) => (c.anchor.source.kind === 'message' ? selectReplyLabel(st, c.anchor.source.id) : null) ?? t('srcChat'),
    instructionOf,
  );
  const ids = pending.map((c) => c.id);
  if (!d(sendMessage(text, force, ids))) return 'offline';
  d(markSending(ids));
  d(setDraft(''));
  return 'sent';
};
