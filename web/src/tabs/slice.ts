import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';

/** `src`: the stable source id ('here', 'ref:<branch>', 'dir:<hash>'); `ref`: its branch, only when it is not 'here' (M3-16). */
export type FileTab = { id: `file:${string}`; kind: 'file'; path: string; src: string; ref?: string };
export type Tab = { id: 'chat'; kind: 'chat' } | FileTab;
export type TabsState = { open: Tab[]; active: Tab['id'] }; // open[0] is always the chat
/** A file to open: a path in this folder, or a path in another source. */
export type FileArg = string | { path: string; src?: string; ref?: string };

const CHAT: Tab = { id: 'chat', kind: 'chat' };
/**
 * The single constructor of file tab ids; ids are never parsed, the tab stores its `path` and `src`. 'here' keeps the
 * old `file:<path>` form, so saved tabs and existing comments keep working.
 */
export const fileTabId = (path: string, src = 'here') => (src === 'here' ? `file:${path}` : `file:${src}:${path}`) as `file:${string}`;
export const fileArg = (a: FileArg): { path: string; src: string; ref?: string } => {
  if (typeof a === 'string') return { path: a, src: 'here' };
  const src = a.src ?? 'here';
  return src === 'here' || !a.ref ? { path: a.path, src } : { path: a.path, src, ref: a.ref };
};
const fileTab = (a: FileArg): FileTab => {
  const f = fileArg(a);
  return { id: fileTabId(f.path, f.src), kind: 'file', ...f };
};

const idx = (s: TabsState, id: string) => s.open.findIndex((t) => t.id === id);

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState: (): TabsState => ({ open: [CHAT], active: 'chat' }),
  reducers: {
    openFile: (s, a: PayloadAction<FileArg>) => {
      const tab = fileTab(a.payload);
      if (idx(s, tab.id) < 0) s.open.push(tab);
      s.active = tab.id;
    },
    activate: (s, a: PayloadAction<Tab['id']>) => {
      if (idx(s, a.payload) >= 0) s.active = a.payload;
    },
    closeTab: (s, a: PayloadAction<Tab['id']>) => {
      const i = idx(s, a.payload);
      if (i <= 0) return; // unknown, or the chat
      s.open.splice(i, 1);
      if (s.active === a.payload) s.active = s.open[i - 1].id;
    },
    closeOthers: (s, a: PayloadAction<Tab['id']>) => {
      const keep = s.open.find((t) => t.id === a.payload);
      s.open = keep && keep.kind !== 'chat' ? [CHAT, keep] : [CHAT];
      if (idx(s, s.active) < 0) s.active = s.open[s.open.length - 1].id;
    },
    closeRight: (s, a: PayloadAction<Tab['id']>) => {
      const i = idx(s, a.payload);
      if (i < 0) return;
      s.open.splice(i + 1);
      if (idx(s, s.active) < 0) s.active = s.open[i].id;
    },
    closeAll: (s) => {
      s.open = [CHAT];
      s.active = 'chat';
    },
    /** Merge previously saved tabs in front of what is already open; the saved active tab wins if it exists. */
    restoreTabs: (s, a: PayloadAction<SavedTabs>) => {
      const have = new Set(s.open.map((t) => t.id));
      const restored = a.payload.files.map(fileTab).filter((t) => !have.has(t.id) && have.add(t.id));
      s.open = [CHAT, ...restored, ...s.open.slice(1)];
      if (idx(s, a.payload.active) >= 0) s.active = a.payload.active as Tab['id'];
    },
  },
});

export const { openFile, activate, closeTab, closeOthers, closeRight, closeAll, restoreTabs } = tabsSlice.actions;

export const selectTabs = (s: RootState): TabsState => s.tabs;
export const selectActiveTab = (s: RootState): Tab => s.tabs.open.find((t) => t.id === s.tabs.active) ?? CHAT;

/** A saved file tab: `src`/`ref` only for another source. */
export type SavedFile = { path: string; src?: string; ref?: string };
export type SavedTabs = { files: SavedFile[]; active: string };

/** What is stored under `tabs:<root>`: the file tabs (with their source when not 'here') and the active id, never the chat tab. */
export const tabsKey = (root: string) => `tabs:${root}`;
export const serializeTabs = (s: TabsState): SavedTabs => ({
  files: s.open.flatMap((t) => (t.kind !== 'file' ? [] : t.src === 'here' ? [{ path: t.path }] : [{ path: t.path, src: t.src, ref: t.ref }])),
  active: s.active,
});
const isSavedFile = (f: unknown): f is SavedFile => {
  const o = f as SavedFile;
  return !!o && typeof o.path === 'string' && (o.src === undefined || typeof o.src === 'string') && (o.ref === undefined || typeof o.ref === 'string');
};
/** Reads `{ files, active }`, or the older `{ paths, active }` (this folder only). */
export function readSavedTabs(root: string): SavedTabs | null {
  try {
    const v = JSON.parse(localStorage.getItem(tabsKey(root)) ?? 'null');
    const active = typeof v?.active === 'string' ? v.active : 'chat';
    if (Array.isArray(v?.files) && v.files.every(isSavedFile)) return { files: v.files, active };
    if (Array.isArray(v?.paths) && v.paths.every((p: unknown) => typeof p === 'string')) return { files: v.paths.map((path: string) => ({ path })), active };
    return null;
  } catch {
    return null;
  }
}
