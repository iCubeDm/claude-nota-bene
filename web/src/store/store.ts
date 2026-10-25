import { configureStore, createAction, createSlice, type Middleware, type ThunkAction, type UnknownAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector, useStore, type TypedUseSelectorHook } from 'react-redux';
import type { ClientMessage, ImageRef, ServerEvent } from '@nota-bene/shared';
import { connect as realConnect } from '../net/socket.ts';
import { t } from '../i18n/index.ts';
import { composerSlice } from '../composer/slice.ts';
import { controlsListener, controlsSlice } from '../controls/slice.ts';
import { commentsSlice, resyncComments } from '../comments/slice.ts';
import { activate, enterRoot, readSavedTabs, serializeTabs, tabsKey, tabsSlice, type Tab, type TabsState } from '../tabs/slice.ts';
import { clearRefCache } from '../refs/refs.ts';
import { loadSources } from '../files/sources.ts';
import { AUDIO, VIDEO } from '../files/kinds.ts';
import { browserPip, MediaController, type PipApi } from '../media/mediaController.ts';
import { filesSlice } from '../files/slice.ts';
import { readSavedDirs, treeKey, treeSlice } from '../tree/slice.ts';
import { statsSlice } from '../stats/slice.ts';
import { tasksSlice } from '../tasks/slice.ts';
import { toast } from '../shell/toast.ts';
import { emptyFeed, reduce, type FeedState } from './feed.ts';

/** A server error is a toast (R-M4-5), never a feed item. A middleware, not a reducer: reducers have no side effects. */
const toastMiddleware: Middleware = () => (next) => (action) => {
  // not `busy`: the server broadcasts those refusals to every window, and a race outcome is not a server error (the asking control shows it inline)
  if (serverEvent.match(action) && action.payload.kind === 'server-error' && action.payload.where !== 'busy') toast(t('serverError', action.payload.where), action.payload.message);
  return next(action);
};

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

const mediaByStore = new WeakMap<object, MediaController>();

/**
 * Tells the media controller about every tab change, whatever caused it (tab click, openFile, close actions, restore):
 * removed tabs go to onClose first, then a changed active tab to onSwitch. It runs right after the reducer, inside the
 * dispatch, so before React renders the new pane, and still inside the click's user activation (PiP needs one).
 */
const mediaMiddleware = (media: MediaController): Middleware => (api) => {
  // diffed against the last tabs it reported, not the state before this action: the store's subscriber dispatches
  // (enterRoot) from inside this dispatch, and that nested change must be reported once, not again on the way out
  let seen: TabsState | null = null;
  return (next) => (action) => {
    seen ??= (api.getState() as { tabs: TabsState }).tabs;
    const result = next(action);
    const after = (api.getState() as { tabs: TabsState }).tabs;
    const before = seen;
    if (after !== before) {
      seen = after;
      // another root (not the first one): every old file tab is closed, even one whose id the new root's tabs share
      const rerooted = before.root !== null && after.root !== before.root;
      const kept = new Set<string>(rerooted ? ['chat'] : after.open.map((t) => t.id));
      for (const t of before.open) if (!kept.has(t.id)) media.onClose(t.id);
      if (after.active !== before.active) media.onSwitch(before.active, after.active);
    }
    return result;
  };
};

/**
 * Creates the store and exactly one socket connection. The socket lives only in this closure
 * (reached by thunks through the thunk `extra` argument), never in Redux state: it is not serializable.
 */
export function makeStore(o: { url: string; connect?: typeof realConnect; pip?: PipApi }) {
  const connectFn = o.connect ?? realConnect;
  let conn: ReturnType<typeof realConnect> | null = null;
  const send: Send = (m) => conn?.send(m) ?? false;
  // one media controller per store; it holds DOM elements, so it lives here and not in state (components reach it via useMedia)
  const media: MediaController = new MediaController({
    pip: o.pip ?? browserPip,
    activate: (id) => store.dispatch(activate(id as Tab['id'])),
    isMedia: (id) => {
      const tab = store.getState().tabs.open.find((t) => t.id === id);
      return tab?.kind === 'file' && (VIDEO.test(tab.path) || AUDIO.test(tab.path));
    },
  });
  const store = configureStore({
    reducer: { feed: feedSlice.reducer, conn: connSlice.reducer, comments: commentsSlice.reducer, composer: composerSlice.reducer, tabs: tabsSlice.reducer, tree: treeSlice.reducer, files: filesSlice.reducer, controls: controlsSlice.reducer, stats: statsSlice.reducer, tasks: tasksSlice.reducer },
    middleware: (gdm) => gdm({ thunk: { extraArgument: { send } } }).prepend(controlsListener.middleware).concat(toastMiddleware, mediaMiddleware(media)),
    devTools: devToolsEnabled(),
  });
  mediaByStore.set(store, media);
  // the ONE place that persists UI state, whoever changed it (toggle, ×, auto-open after adding a comment, tab changes)
  let panelOpen = store.getState().comments.ui.panelOpen;
  let tabs = store.getState().tabs;
  let dirs = store.getState().tree.dirs;
  let restoredRoot: string | null = null;
  store.subscribe(() => {
    let st = store.getState();
    const now = st.comments.ui.panelOpen;
    if (now !== panelOpen) {
      panelOpen = now;
      try { localStorage.setItem('panel:comments', now ? '1' : '0'); } catch { /* storage unavailable: not persisted */ }
    }
    const root = st.feed.session?.root;
    if (root && root !== restoredRoot) {
      // every root change (the first one, a switch to another folder, a switch back): that root's saved tabs and tree.
      // Read before the dispatch: it re-enters this subscriber, which persists under the new root at once.
      const first = restoredRoot === null;
      restoredRoot = root;
      const saved = readSavedTabs(root);
      const savedDirs = readSavedDirs(root);
      // source ids are stable (M3-16): every saved tab comes back at once, whatever /sources says; a tab whose source
      // is gone keeps its place and says so in its view. The load feeds the picker and absolute refs; another root has
      // other worktrees and branches, and its paths other HEAD answers, so both caches are dropped then.
      if (!first) clearRefCache();
      void loadSources(!first);
      store.dispatch(enterRoot({ root, first, tabs: saved, dirs: savedDirs }));
      // the restore re-entered this subscriber, which persisted it; `st` is stale now and would write the
      // pre-restore state back over it
      st = store.getState();
      dirs = st.tree.dirs;
      tabs = st.tabs;
    }
    if (st.tree.dirs !== dirs) {
      dirs = st.tree.dirs;
      if (restoredRoot) {
        try { localStorage.setItem(treeKey(restoredRoot, st.tree.src), JSON.stringify(dirs)); } catch { /* not persisted */ }
      }
    }
    if (st.tabs !== tabs) {
      tabs = st.tabs;
      // before the root is known there is nothing to key by; the restore merges these tabs in later
      if (restoredRoot) {
        try { localStorage.setItem(tabsKey(restoredRoot), JSON.stringify(serializeTabs(tabs))); } catch { /* not persisted */ }
      }
    }
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
/** The store's media controller (see makeStore). */
export const useMedia = (): MediaController => mediaByStore.get(useStore())!;

export const selectFeed = (s: RootState): FeedState => s.feed;
export const selectBusy = (s: RootState): boolean => s.feed.busy;
export const selectConn = (s: RootState): ConnState => s.conn.state;
export const selectTurnSeq = (s: RootState): number => s.feed.turnSeq;
export const selectSession = (s: RootState) => s.feed.session;

export const sendMessage =
  (text: string, force: boolean, commentIds?: string[], images?: ImageRef[]): AppThunk<boolean> =>
  (_d, getState, { send }) => {
    const st = getState();
    if (selectConn(st) !== 'open') return false;
    return send({
      type: 'send', id: crypto.randomUUID(), text, force: force && selectBusy(st),
      ...(commentIds?.length ? { commentIds } : {}),
      ...(images?.length ? { images } : {}),
    });
  };

export const interrupt = (): AppThunk => (_d, getState, { send }) => {
  if (selectBusy(getState())) send({ type: 'interrupt' });
};

export const answerPermission = (id: string, allow: boolean, input?: Record<string, unknown>): AppThunk => (_d, _g, { send }) => {
  send({ type: 'permission', id, allow, ...(input ? { input } : {}) });
};

/**
 * Where a comment's source sits, for the batch text: "reply #n" for a FINAL assistant item (n = 1-based among final
 * assistant items in feed order), "my message" for a user item, null otherwise. The feed keeps no time per assistant
 * item, so the " · time" part of `reply` is dropped rather than invented.
 */
export const selectReplyLabel = (s: RootState, messageId: string): string | null => {
  if (messageId.startsWith('plan:')) return s.feed.items.some((it) => it.kind === 'permission' && `plan:${it.id}` === messageId) ? t('mode_plan') : null;
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
