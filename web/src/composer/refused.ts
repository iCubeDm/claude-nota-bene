import type { Middleware } from '@reduxjs/toolkit';
import { unmarkSending } from '../comments/slice.ts';
import { t } from '../i18n/index.ts';
import { toast } from '../shell/toast.ts';
import { addImage, setDraft } from './slice.ts';
import { serverEvent } from '../store/store.ts';
import type { SentDraft, ShellDraft } from './slice.ts';

// RootState is derived from this middleware's store: naming it here would make the type circular
type Slice = { composer: { draft: string; images: unknown[]; unconfirmed: SentDraft | null; shellUnconfirmed: ShellDraft | null } };

/**
 * The server refused a send (`send-refused`, only to the asking socket, never stored). Put the draft back unless the
 * user has already typed something new (then the toast carries the refused text, so nothing is lost silently), and let
 * the comments of that send be sent again. A middleware: it must read `composer.unconfirmed` before the reducer drops it.
 * (`serverEvent` is read only when an action arrives: store.ts and this file import each other.)
 */
export const refusedMiddleware: Middleware = (api) => (next) => (action) => {
  const shell = serverEvent.match(action) && action.payload.kind === 'shell-refused' ? action.payload : undefined;
  if (shell) {
    // the same for a `! cmd` the server did not take: the draft comes back (or rides in the toast), nothing is lost
    const last = (api.getState() as Slice).composer.shellUnconfirmed;
    const result = next(action);
    if (!last || last.id !== shell.id) return result;
    const why = t(shell.reason === 'running' ? 'shellBusy' : 'shellSwitching');
    if (!(api.getState() as Slice).composer.draft.trim()) {
      api.dispatch(setDraft(last.draft));
      toast(why, '');
    } else toast(why, last.draft.length > 200 ? `${last.draft.slice(0, 199)}…` : last.draft);
    return result;
  }
  const ev = serverEvent.match(action) && action.payload.kind === 'send-refused' ? action.payload : undefined;
  const refused = ev?.id;
  const why = t(ev?.reason === 'busy' ? 'sendRefusedBusy' : 'sendRefused');
  const last = refused ? (api.getState() as Slice).composer.unconfirmed : null;
  const result = next(action);
  if (!refused || !last || last.id !== refused) return result;
  api.dispatch(unmarkSending(last.commentIds));
  const now = (api.getState() as Slice).composer;
  if (!now.draft.trim() && !now.images.length) {
    api.dispatch(setDraft(last.text));
    for (const im of last.images) api.dispatch(addImage(im));
    toast(why, '');
  } else {
    toast(why, last.text.length > 200 ? `${last.text.slice(0, 199)}…` : last.text);
  }
  return result;
};
