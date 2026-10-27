import type { ListenerMiddlewareInstance } from '@reduxjs/toolkit';
import { enterRoot, readSavedTabs, serializeTabs, tabsKey, type TabsState } from '../tabs/slice.ts';
import { readSavedDirs, treeKey, type treeSlice } from '../tree/slice.ts';
import type { commentsSlice } from '../comments/slice.ts';
import { clearRefCache } from '../refs/refs.ts';
import { loadSources } from '../files/sources.ts';
import { pushRecent, RECENT_DWELL_MS } from '../files/recent.ts';
import type { FeedState } from './feed.ts';

/** The slices the persistence reads. Named here, not taken from the store's RootState: the store's type is built from the listeners' middleware. */
export type PersistState = { feed: FeedState; comments: ReturnType<typeof commentsSlice.reducer>; tree: ReturnType<typeof treeSlice.reducer>; tabs: TabsState };

/**
 * The ONE place that persists UI state, whoever changed it (toggle, ×, auto-open after adding a comment, tab changes):
 * one listener per concern, each comparing the state before the action with the state after it. Tree and tab writes
 * wait for the first known root and are keyed by it (`restoredRoot`); the root-change listener is registered first, so
 * its restore is already in place when the others look at the same action.
 */
export function persistListeners(lm: ListenerMiddlewareInstance<PersistState>): void {
  let restoredRoot: string | null = null;

  const put = (key: string, value: string): void => {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable: not persisted */ }
  };

  // every root change (the first one, a switch to another folder, a switch back): that root's saved tabs and tree.
  // The saved state is read before the dispatch: the restore's own change is persisted under the new root by the
  // listeners below (the dispatch runs them nested), so nothing here writes it.
  lm.startListening({
    predicate: (_a, st) => !!st.feed.session?.root && st.feed.session.root !== restoredRoot,
    effect: (_a, api) => {
      const root = api.getState().feed.session?.root;
      if (!root || root === restoredRoot) return;
      const first = restoredRoot === null;
      restoredRoot = root;
      const tabs = readSavedTabs(root);
      const dirs = readSavedDirs(root);
      // source ids are stable (M3-16): every saved tab comes back at once, whatever /sources says; a tab whose source
      // is gone keeps its place and says so in its view. The load feeds the picker and absolute refs; another root has
      // other worktrees and branches, and its paths other HEAD answers, so both caches are dropped then.
      if (!first) clearRefCache();
      void loadSources(!first);
      api.dispatch(enterRoot({ root, first, tabs, dirs }));
    },
  });

  lm.startListening({
    predicate: (_a, st, was) => st.comments.ui.panelOpen !== was.comments.ui.panelOpen,
    effect: (_a, api) => put('panel:comments', api.getState().comments.ui.panelOpen ? '1' : '0'),
  });

  lm.startListening({
    predicate: (_a, st, was) => st.tree.open !== was.tree.open,
    effect: (_a, api) => put('panel:tree', api.getState().tree.open ? '1' : '0'),
  });

  lm.startListening({
    predicate: (_a, st, was) => st.tree.dirs !== was.tree.dirs,
    effect: (_a, api) => {
      if (!restoredRoot) return;
      const { dirs, src } = api.getState().tree;
      put(treeKey(restoredRoot, src), JSON.stringify(dirs));
    },
  });

  // before the root is known there is nothing to key by; the restore merges those tabs in later
  lm.startListening({
    predicate: (_a, st, was) => st.tabs !== was.tabs,
    effect: (_a, api) => {
      if (restoredRoot) put(tabsKey(restoredRoot), JSON.stringify(serializeTabs(api.getState().tabs)));
    },
  });

  // a file tab became active and stays so a moment: the most recent file of this root (Alt+E, M6-13).
  // The next active change cancels the wait (also when it activates a non-file tab).
  lm.startListening({
    predicate: (_a, st, was) => st.tabs.active !== was.tabs.active,
    effect: async (_a, api) => {
      api.cancelActiveListeners();
      const at = restoredRoot;
      if (!at) return;
      const { tabs } = api.getState();
      const f = tabs.open.find((x) => x.id === tabs.active);
      if (f?.kind !== 'file') return;
      try { await api.delay(RECENT_DWELL_MS); } catch { return; } // cancelled
      const now = api.getState().tabs;
      if (now.active === f.id && now.root === at) pushRecent(at, { path: f.path, ...(f.src !== 'here' && { src: f.src }), ...(f.ref && { ref: f.ref }) });
    },
  });
}
