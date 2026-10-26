import type { Middleware } from '@reduxjs/toolkit';
import { unmarkSending } from '../comments/slice.ts';
import { t } from '../i18n/index.ts';
import { toast } from '../shell/toast.ts';
import { addImage, setDraft } from './slice.ts';
import { serverEvent } from '../store/store.ts';
import type { SentDraft } from './slice.ts';

// RootState is derived from this middleware's store: naming it here would make the type circular
type Slice = { composer: { draft: string; images: unknown[]; unconfirmed: SentDraft | null } };

/**
 * The server refused a send (`send-refused`, only to the asking socket, never stored). Put the draft back unless the
 * user has already typed something new (then the toast carries the refused text, so nothing is lost silently), and let
 * the comments of that send be sent again. A middleware: it must read `composer.unconfirmed` before the reducer drops it.
 * (`serverEvent` is read only when an action arrives: store.ts and this file import each other.)
 */
export const refusedMiddleware: Middleware = (api) => (next) => (action) => {
  const refused = serverEvent.match(action) && action.payload.kind === 'send-refused' ? action.payload.id : undefined;
  const last = refused ? (api.getState() as Slice).composer.unconfirmed : null;
  const result = next(action);
  if (!refused || !last || last.id !== refused) return result;
  api.dispatch(unmarkSending(last.commentIds));
  const now = (api.getState() as Slice).composer;
  if (!now.draft.trim() && !now.images.length) {
    api.dispatch(setDraft(last.text));
    for (const im of last.images) api.dispatch(addImage(im));
    toast(t('sendRefused'), '');
  } else {
    toast(t('sendRefused'), last.text.length > 200 ? `${last.text.slice(0, 199)}…` : last.text);
  }
  return result;
};
