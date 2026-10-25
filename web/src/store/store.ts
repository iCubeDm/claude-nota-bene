import { configureStore, createAction, createSlice, type ThunkAction, type UnknownAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { connect as realConnect } from '../net/socket.ts';
import { t } from '../i18n/index.ts';
import { composerSlice } from '../composer/slice.ts';
import { commentsSlice, resyncComments } from '../comments/slice.ts';
import { emptyFeed, reduce, type FeedState } from './feed.ts';

/** The only way server data enters the store. */
export const serverEvent = createAction<ServerEvent>('server/event');
export const connState = createAction<'open' | 'closed'>('conn/state');

// reduce() is pure and returns a new object. Returning a new state from an Immer case reducer is
// allowed, so we hand it the draft cast to FeedState: reduce only reads it and spreads/slices
// (never mutates), and Immer drops the draft when a new value is returned. No current() needed.
export const feedSlice = createSlice({
  name: 'feed',
  initialState: emptyFeed,
  reducers: {},
  extraReducers: (b) => b.addCase(serverEvent, (state, a) => reduce(state as FeedState, a.payload)),
});

export type ConnState = 'connecting' | 'open' | 'closed'; // connecting = never open yet; closed = dropped after an open

export const connSlice = createSlice({
  name: 'conn',
  initialState: { state: 'connecting' as ConnState },
  reducers: {},
  extraReducers: (b) => b.addCase(connState, (_s, a) => ({ state: a.payload })),
});

type Send = (m: ClientMessage) => boolean;

/** Whether Redux DevTools are on: dev builds only. Read at call time so tests can stub it. */
export const devToolsEnabled = (): boolean => import.meta.env.DEV;

/**
 * Creates the store and exactly one socket connection. The socket lives only in this closure
 * (reached by thunks through the thunk `extra` argument), never in Redux state: it is not serializable.
 */
export function makeStore(o: { url: string; connect?: typeof realConnect }) {
  const connectFn = o.connect ?? realConnect;
  let conn: ReturnType<typeof realConnect> | null = null;
  const send: Send = (m) => conn?.send(m) ?? false;
  const store = configureStore({
    reducer: { feed: feedSlice.reducer, conn: connSlice.reducer, comments: commentsSlice.reducer, composer: composerSlice.reducer },
    middleware: (gdm) => gdm({ thunk: { extraArgument: { send } } }),
    devTools: devToolsEnabled(),
  });
  // the ONE place that persists the panel state, whoever changed it (toggle, ×, auto-open after adding a comment)
  let panelOpen = store.getState().comments.ui.panelOpen;
  store.subscribe(() => {
    const now = store.getState().comments.ui.panelOpen;
    if (now === panelOpen) return;
    panelOpen = now;
    try { localStorage.setItem('panel:comments', now ? '1' : '0'); } catch { /* storage unavailable: not persisted */ }
  });
  conn = connectFn(
    o.url,
    (ev) => store.dispatch(serverEvent(ev)),
    (s) => {
      store.dispatch(connState(s));
      if (s === 'open') store.dispatch(resyncComments());
    },
  );
  return store;
}

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
export type AppThunk<R = void> = ThunkAction<R, RootState, { send: Send }, UnknownAction>;

export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useAppDispatch: () => AppDispatch = useDispatch;

export const selectFeed = (s: RootState): FeedState => s.feed;
export const selectBusy = (s: RootState): boolean => s.feed.busy;
export const selectConn = (s: RootState): ConnState => s.conn.state;
export const selectSession = (s: RootState) => s.feed.session;

export const sendMessage =
  (text: string, force: boolean, commentIds?: string[]): AppThunk<boolean> =>
  (_d, getState, { send }) => {
    const st = getState();
    if (selectConn(st) !== 'open') return false;
    return send({
      type: 'send', id: crypto.randomUUID(), text, force: force && selectBusy(st),
      ...(commentIds?.length ? { commentIds } : {}),
    });
  };

export const interrupt = (): AppThunk => (_d, getState, { send }) => {
  if (selectBusy(getState())) send({ type: 'interrupt' });
};

export const answerPermission = (id: string, allow: boolean): AppThunk => (_d, _g, { send }) => {
  send({ type: 'permission', id, allow });
};

/**
 * Where a comment's source sits, for the batch text: "reply #n" for a FINAL assistant item (n = 1-based among final
 * assistant items in feed order), "my message" for a user item, null otherwise. The feed keeps no time per assistant
 * item, so the " · time" part of `reply` is dropped rather than invented.
 */
export const selectReplyLabel = (s: RootState, messageId: string): string | null => {
  let n = 0;
  for (const it of s.feed.items) {
    if (it.kind === 'assistant' && it.final) n++;
    if ((it.kind === 'assistant' || it.kind === 'user') && it.id === messageId) {
      if (it.kind === 'user') return t('srcMine');
      return it.final ? t('reply', n, '').replace(/\s*·\s*$/, '') : null;
    }
  }
  return null;
};
