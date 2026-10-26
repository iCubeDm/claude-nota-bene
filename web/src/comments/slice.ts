import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { isMediaAnchor, type Comment, type MediaAnchor } from '@nota-bene/shared';
import { fileKey } from '../files/sources.ts';
// store.ts imports this file for the reducer; every use of serverEvent below is lazy (inside callbacks), so the cycle is safe.
import { connState, serverEvent, type AppThunk, type RootState } from '../store/store.ts';

export type CommentCard = { id: string; x: number; y: number };
export type CommentsState = { items: Comment[]; /** a local change the server has not received */ unsynced: boolean; /** local set re-sent on reconnect; the server's initial (stale) push is still to come and must be ignored once */ resent: boolean; /** ids handed to the socket whose `comments` echo has not arrived yet (client-only; keeps a double send out) */ sendingIds: string[]; ui: { panelOpen: boolean; card: CommentCard | null } };

const readPanelOpen = (): boolean => {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem('panel:comments') !== '0';
  } catch {
    return true; // storage unavailable: the default, open
  }
};

export const commentsSlice = createSlice({
  name: 'comments',
  initialState: (): CommentsState => ({ items: [], unsynced: false, resent: false, sendingIds: [], ui: { panelOpen: readPanelOpen(), card: null } }),
  reducers: {
    setItems: (s, a: PayloadAction<Comment[]>) => void (s.items = a.payload),
    markSending: (s, a: PayloadAction<string[]>) => void (s.sendingIds = [...s.sendingIds, ...a.payload]),
    unmarkSending: (s, a: PayloadAction<string[]>) => void (s.sendingIds = s.sendingIds.filter((id) => !a.payload.includes(id))),
    setUnsynced: (s, a: PayloadAction<boolean>) => void (s.unsynced = a.payload),
    markResent: (s) => void ((s.unsynced = false), (s.resent = true)),
    setPanelOpen: (s, a: PayloadAction<boolean>) => void (s.ui.panelOpen = a.payload),
    openCommentCard: (s, a: PayloadAction<CommentCard>) => void (s.ui.card = a.payload),
    closeCommentCard: (s) => void (s.ui.card = null),
  },
  // only a `comments` event replaces items; `replay` must not clear them (the server sends replay first)
  extraReducers: (b) =>
    b.addCase(connState, (s, a) => {
      if (a.payload === 'open') return;
      s.sendingIds = []; // the in-flight send may be lost with the socket
      // the re-send was never confirmed (its stale initial push did not arrive): it may be lost too, so send it again next open
      if (s.resent) { s.resent = false; s.unsynced = true; }
    }).addCase(serverEvent, (s, a) => {
      if (a.payload.kind === 'comments') {
        // drop an id once the echo shows it sent or gone; a foreign echo that still lists it as pending keeps it in flight
        const items = a.payload.items;
        s.sendingIds = s.sendingIds.filter((id) => items.find((c) => c.id === id)?.status === 'pending');
      }
      // while unsynced, local offline edits win; they are re-sent on reconnect (resyncComments)
      if (a.payload.kind !== 'comments') return;
      if (s.unsynced) return;
      if (s.resent) { s.resent = false; return; } // the server's initial push predates our re-send: stale, skip it once
      s.items = a.payload.items;
    }),
});

export const { markSending, unmarkSending, setPanelOpen, openCommentCard, closeCommentCard } = commentsSlice.actions;

/** Update locally first, then send the FULL set; a closed socket keeps the local change for the next sync. */
// Accepted race: two edits within one round trip can see the first echo overwrite the second locally until the second echo lands.
const sync = (items: Comment[]): AppThunk => (d, getState, { send }) => {
  d(commentsSlice.actions.setItems(items));
  d(commentsSlice.actions.setUnsynced(!send({ type: 'comments', sessionId: getState().feed.session?.id ?? null, items })));
};

/** On socket open: re-send local changes made while offline (local wins; last-writer-wins between windows is accepted). */
export const resyncComments = (): AppThunk => (d, getState, { send }) => {
  const st = getState().comments;
  if (st.unsynced && send({ type: 'comments', sessionId: getState().feed.session?.id ?? null, items: st.items })) d(commentsSlice.actions.markResent());
};

/** `id`: caller-given (a media comment's mark folder is named by it, so it exists before the comment); else a fresh one. */
export const addComment = (c: Omit<Comment, 'id' | 'status' | 'createdAt'> & { id?: string }): AppThunk => (d, getState) => {
  const next: Comment = { ...c, id: c.id ?? crypto.randomUUID(), status: 'pending', createdAt: Date.now() };
  d(sync([...selectComments(getState()), next]));
};

export const editComment = (id: string, text: string): AppThunk => (d, getState) => {
  d(sync(selectComments(getState()).map((c) => (c.id === id ? { ...c, text } : c))));
};

export const removeComment = (id: string): AppThunk => (d, getState) => {
  d(sync(selectComments(getState()).filter((c) => c.id !== id)));
};

export const selectComments = (s: RootState): Comment[] => s.comments.items;
export const selectCommentsUi = (s: RootState) => s.comments.ui;
const EMPTY: Comment[] = Object.freeze([]) as unknown as Comment[];
const selectSendingIds = (s: RootState) => s.comments.sendingIds;
/** Pending and not already on the wire. */
export const selectPending = createSelector([selectComments, selectSendingIds], (items, sending) =>
  items.filter((c) => c.status === 'pending' && !sending.includes(c.id)));
const selectSentByMessage = createSelector([selectComments], (items) => {
  const m: Record<string, Comment[]> = {};
  for (const c of items) if (c.status === 'sent' && c.sentIn !== undefined) (m[c.sentIn] ??= []).push(c);
  return m;
});
export const selectSentFor = (s: RootState, messageId: string): Comment[] => selectSentByMessage(s)[messageId] ?? EMPTY;

/** Pending comments per file, keyed by `fileKey(path, ref)` (the path alone in this folder). */
export const selectPendingCountByPath = createSelector([selectComments], (items) => {
  const m: Record<string, number> = {};
  for (const c of items) {
    const src = c.anchor.source;
    if (c.status !== 'pending' || src.kind !== 'file') continue;
    const k = fileKey(src.path, src.ref);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
});

export type MediaComment = Comment & { anchor: MediaAnchor };
/** The media comments on one file of one source (`ref` only for another source), in store order. Memoised per (path, ref). */
export const selectMediaComments = createSelector(
  [selectComments, (_s: RootState, path: string) => path, (_s: RootState, _p: string, ref?: string) => ref ?? ''],
  (items, path, ref): MediaComment[] =>
    items.filter((c): c is MediaComment => isMediaAnchor(c.anchor) && c.anchor.source.path === path && (c.anchor.source.ref ?? '') === ref),
);
