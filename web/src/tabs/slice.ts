import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../store/store.ts';

export type Tab = { id: 'chat'; kind: 'chat' } | { id: `file:${string}`; kind: 'file'; path: string };
export type TabsState = { open: Tab[]; active: Tab['id'] }; // open[0] is always the chat

const CHAT: Tab = { id: 'chat', kind: 'chat' };
/** The single constructor of file tab ids; ids are never parsed, the tab stores its `path`. */
export const fileTabId = (path: string) => `file:${path}` as const;
const fileTab = (path: string): Tab => ({ id: fileTabId(path), kind: 'file', path });

const idx = (s: TabsState, id: string) => s.open.findIndex((t) => t.id === id);

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState: (): TabsState => ({ open: [CHAT], active: 'chat' }),
  reducers: {
    openFile: (s, a: PayloadAction<string>) => {
      const id = fileTabId(a.payload);
      if (idx(s, id) < 0) s.open.push(fileTab(a.payload));
      s.active = id;
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
    restoreTabs: (s, a: PayloadAction<{ paths: string[]; active: string }>) => {
      const have = new Set(s.open.map((t) => t.id));
      const restored = a.payload.paths.map(fileTab).filter((t) => !have.has(t.id) && have.add(t.id));
      s.open = [CHAT, ...restored, ...s.open.slice(1)];
      if (idx(s, a.payload.active) >= 0) s.active = a.payload.active as Tab['id'];
    },
  },
});

export const { openFile, activate, closeTab, closeOthers, closeRight, closeAll, restoreTabs } = tabsSlice.actions;

export const selectTabs = (s: RootState): TabsState => s.tabs;
export const selectActiveTab = (s: RootState): Tab => s.tabs.open.find((t) => t.id === s.tabs.active) ?? CHAT;

/** What is stored under `tabs:<root>`: file paths and the active id, never the chat tab. */
export const tabsKey = (root: string) => `tabs:${root}`;
export const serializeTabs = (s: TabsState) => ({
  paths: s.open.flatMap((t) => (t.kind === 'file' ? [t.path] : [])),
  active: s.active,
});
export function readSavedTabs(root: string): { paths: string[]; active: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(tabsKey(root)) ?? 'null');
    if (!v || !Array.isArray(v.paths) || !v.paths.every((p: unknown) => typeof p === 'string')) return null;
    return { paths: v.paths, active: typeof v.active === 'string' ? v.active : 'chat' };
  } catch {
    return null;
  }
}
