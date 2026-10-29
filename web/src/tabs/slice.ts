import { createAction, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { TASK_ID, TOOL_USE_ID } from '@nota-bene/shared';
import type { RootState } from '../store/store.ts';
import type { DiagramLang } from '../diagram/render.ts';
import { sha1 } from '../diagram/sha1.ts';

/** `src`: the stable source id ('here', 'ref:<branch>', 'dir:<hash>'); `ref`: its branch, only when it is not 'here' (M3-16). */
export type FileTab = { id: `file:${string}`; kind: 'file'; path: string; src: string; ref?: string };
/** One rendered diagram (M7-01, R-M7-12): it holds its source, so it survives a reload and needs no file. */
export type DiagramTab = { id: `diagram:${string}`; kind: 'diagram'; source: string; lang: DiagramLang; title: string };
/**
 * A subagent's conversation (M2 step 1), read-only: `tool` is the tool-use id of the Agent call that started it. The id
 * is built from it (never parsed back); `title` is the Agent call's description, kept so a restored tab has a name before it loads.
 */
export type AgentTab = { id: `agent:${string}`; kind: 'agent'; tool: string; title: string };
/**
 * A background shell / Monitor task's output (M2 step 2), read-only: `task` is the CLI's task id. The title is the task's
 * description at the time it was opened (a task the server no longer knows still has a name).
 */
export type ShellTab = { id: `shell:${string}`; kind: 'shell'; task: string; title: string };
/** `settings`: the one Settings tab (M6-15, R-M6-4); not saved with the file tabs. */
export type Tab = { id: 'chat'; kind: 'chat' } | { id: 'settings'; kind: 'settings' } | FileTab | DiagramTab | AgentTab | ShellTab;
/**
 * open[0] is always the chat. `root`: the project the file tabs belong to (null until the first session event).
 * `rootGen`: bumped on every root change after the first, so views keyed by it remount (the same path in another root
 * is another file). `closed`: the file tabs closed in this page's life, last closed last (Alt+Shift+T reopens; M6-14).
 */
export type TabsState = { open: Tab[]; active: Tab['id']; root: string | null; rootGen: number; closed: FileArg[] };
/** How many closed tabs Alt+Shift+T can bring back. */
export const CLOSED_MAX = 30;
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

export const agentTabId = (tool: string) => `agent:${tool}` as const;
export const shellTabId = (task: string) => `shell:${task}` as const;
const shellTab = ({ task, title }: SavedShell): ShellTab => ({ id: shellTabId(task), kind: 'shell', task, title });
const agentTab = ({ tool, title }: SavedAgent): AgentTab => ({ id: agentTabId(tool), kind: 'agent', tool, title });

/** The title of a diagram tab: the first line of its source, up to 40 characters. */
const DIAGRAM_TITLE_MAX = 40;
/** Same source, same id, so the same diagram opened twice reuses its tab. */
export const diagramTabId = (source: string) => `diagram:${sha1(source).slice(0, 8)}` as const;
const diagramTab = ({ source, lang }: SavedDiagram): DiagramTab => ({
  id: diagramTabId(source),
  kind: 'diagram',
  source,
  lang,
  title: (source.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, DIAGRAM_TITLE_MAX),
});

/**
 * The window's project root became known or changed (a switch to another folder, here or in another window). One action
 * for every slice, so the tabs, the tree and the file state change together: the tabs become that root's saved ones
 * (merged on the first root, replacing after), the tree shows its saved folders, the file load state is dropped.
 * The saved state is read by the caller (the store's subscriber), before anything is persisted under the new root.
 */
export const enterRoot = createAction<{ root: string; first: boolean; tabs: SavedTabs | null; dirs: string[] | null }>('tabs/enterRoot');

const idx = (s: TabsState, id: string) => s.open.findIndex((t) => t.id === id);

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState: (): TabsState => ({ open: [CHAT], active: 'chat', root: null, rootGen: 0, closed: [] }),
  reducers: {
    openFile: (s, a: PayloadAction<FileArg>) => {
      const tab = fileTab(a.payload);
      if (idx(s, tab.id) < 0) s.open.push(tab);
      s.active = tab.id;
    },
    /** Opens (once) and activates the Settings tab. */
    openSettings: (s) => {
      if (idx(s, 'settings') < 0) s.open.push({ id: 'settings', kind: 'settings' });
      s.active = 'settings';
    },
    /** Opens (once per source) and activates a diagram's tab. */
    openDiagram: (s, a: PayloadAction<SavedDiagram>) => {
      const tab = diagramTab(a.payload);
      if (idx(s, tab.id) < 0) s.open.push(tab);
      s.active = tab.id;
    },
    /** Opens (once per Agent call) and activates a subagent's tab; an empty title keeps the one it has. */
    openAgent: (s, a: PayloadAction<SavedAgent>) => {
      const tab = agentTab(a.payload);
      const i = idx(s, tab.id);
      if (i < 0) s.open.push(tab);
      else if (tab.title && s.open[i]!.kind === 'agent') (s.open[i] as AgentTab).title = tab.title;
      s.active = tab.id;
    },
    /** The subagent's real description arrived: it names its tab (a restored tab had the saved one). */
    setAgentTitle: (s, a: PayloadAction<SavedAgent>) => {
      const t = s.open[idx(s, agentTabId(a.payload.tool))];
      if (t?.kind === 'agent' && a.payload.title && t.title !== a.payload.title) t.title = a.payload.title;
    },
    /** Opens (once per task) and activates a shell task's output tab. */
    openShell: (s, a: PayloadAction<SavedShell>) => {
      const tab = shellTab(a.payload);
      if (idx(s, tab.id) < 0) s.open.push(tab);
      s.active = tab.id;
    },
    activate: (s, a: PayloadAction<Tab['id']>) => {
      if (idx(s, a.payload) >= 0) s.active = a.payload;
    },
    closeTab: (s, a: PayloadAction<Tab['id']>) => {
      const i = idx(s, a.payload);
      if (i <= 0) return; // unknown, or the chat
      remember(s, s.open.splice(i, 1));
      if (s.active === a.payload) s.active = s.open[i - 1].id;
    },
    closeOthers: (s, a: PayloadAction<Tab['id']>) => {
      const keep = s.open.find((t) => t.id === a.payload);
      remember(s, s.open.filter((t) => t !== keep));
      s.open = keep && keep.kind !== 'chat' ? [CHAT, keep] : [CHAT];
      if (idx(s, s.active) < 0) s.active = s.open[s.open.length - 1].id;
    },
    closeRight: (s, a: PayloadAction<Tab['id']>) => {
      const i = idx(s, a.payload);
      if (i < 0) return;
      remember(s, s.open.splice(i + 1));
      if (idx(s, s.active) < 0) s.active = s.open[i].id;
    },
    closeAll: (s) => {
      remember(s, s.open);
      s.open = [CHAT];
      s.active = 'chat';
    },
    /** The last closed file tab opens again and becomes active (one already open again is skipped). */
    reopenClosed: (s) => {
      for (let f = s.closed.pop(); f; f = s.closed.pop()) {
        const tab = fileTab(f);
        if (idx(s, tab.id) >= 0) continue;
        s.open.push(tab);
        s.active = tab.id;
        return;
      }
    },
    /** Merge previously saved tabs in front of what is already open; the saved active tab wins if it exists. */
    restoreTabs: (s, a: PayloadAction<SavedTabs>) => restore(s, a.payload, true),
  },
  extraReducers: (b) =>
    b.addCase(enterRoot, (s, a) => {
      // the first root merges (tabs opened before the root was known stay); any later root replaces
      const { first } = a.payload;
      s.root = a.payload.root;
      if (!first) {
        s.rootGen++;
        s.closed = []; // another root's files
        s.open = [CHAT];
        s.active = 'chat';
      }
      if (a.payload.tabs) restore(s, a.payload.tabs, first);
    }),
});

function remember(s: TabsState, tabs: Tab[]): void {
  for (const t of tabs) if (t.kind === 'file') s.closed.push({ path: t.path, src: t.src, ...(t.ref && { ref: t.ref }) });
  if (s.closed.length > CLOSED_MAX) s.closed.splice(0, s.closed.length - CLOSED_MAX);
}

function restore(s: TabsState, saved: SavedTabs, merge: boolean): void {
  const have = new Set(merge ? s.open.map((t) => t.id) : ['chat']);
  const restored = saved.tabs.map((t) => ('file' in t ? fileTab(t.file) : 'agent' in t ? agentTab(t.agent) : 'shell' in t ? shellTab(t.shell) : diagramTab(t.diagram))).filter((t) => !have.has(t.id) && have.add(t.id));
  s.open = [CHAT, ...restored, ...(merge ? s.open.slice(1) : [])];
  if (idx(s, saved.active) >= 0) s.active = saved.active as Tab['id'];
}

export const { openFile, openSettings, openDiagram, openAgent, openShell, setAgentTitle, activate, closeTab, closeOthers, closeRight, closeAll, reopenClosed, restoreTabs } = tabsSlice.actions;

export const selectTabs = (s: RootState): TabsState => s.tabs;
export const selectActiveTab = (s: RootState): Tab => s.tabs.open.find((t) => t.id === s.tabs.active) ?? CHAT;

/** A saved file tab: `src`/`ref` only for another source. */
export type SavedFile = { path: string; src?: string; ref?: string };
/** A saved diagram tab: its source and language (the id and title are made from them). */
export type SavedDiagram = { source: string; lang: DiagramLang };
/** A saved subagent tab: the Agent call's tool-use id and the title it had. */
export type SavedAgent = { tool: string; title: string };
/** A saved shell tab: the task id and the title it had. */
export type SavedShell = { task: string; title: string };
/** One saved tab, in strip order. */
export type SavedTab = { file: SavedFile } | { diagram: SavedDiagram } | { agent: SavedAgent } | { shell: SavedShell };
export type SavedTabs = { tabs: SavedTab[]; active: string };

/**
 * What is stored under `tabs:<root>`: the file tabs (with their source when not 'here') and the diagram tabs (with
 * their source text), in strip order, and the active id; never the chat tab.
 */
export const tabsKey = (root: string) => `tabs:${root}`;
export const serializeTabs = (s: TabsState): SavedTabs => ({
  tabs: s.open.flatMap((t): SavedTab[] =>
    t.kind === 'file' ? [{ file: t.src === 'here' ? { path: t.path } : { path: t.path, src: t.src, ref: t.ref } }]
    : t.kind === 'diagram' ? [{ diagram: { source: t.source, lang: t.lang } }]
    : t.kind === 'agent' ? [{ agent: { tool: t.tool, title: t.title } }]
    : t.kind === 'shell' ? [{ shell: { task: t.task, title: t.title } }]
    : []),
  active: s.active,
});
const isSavedFile = (f: unknown): f is SavedFile => {
  const o = f as SavedFile;
  return !!o && typeof o.path === 'string' && (o.src === undefined || typeof o.src === 'string') && (o.ref === undefined || typeof o.ref === 'string');
};
const isSavedDiagram = (d: unknown): d is SavedDiagram => {
  const o = d as SavedDiagram;
  return !!o && typeof o.source === 'string' && (o.lang === 'mermaid' || o.lang === 'svg');
};
const isSavedAgent = (a: unknown): a is SavedAgent => {
  const o = a as SavedAgent;
  return !!o && typeof o.tool === 'string' && TOOL_USE_ID.test(o.tool) && typeof o.title === 'string';
};
const isSavedShell = (a: unknown): a is SavedShell => {
  const o = a as SavedShell;
  return !!o && typeof o.task === 'string' && TASK_ID.test(o.task) && typeof o.title === 'string';
};
const isSavedTab = (t: unknown): t is SavedTab => {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return ('file' in o && isSavedFile(o.file)) || ('diagram' in o && isSavedDiagram(o.diagram)) || ('agent' in o && isSavedAgent(o.agent)) || ('shell' in o && isSavedShell(o.shell));
};
/** Reads `{ tabs, active }`, or the older `{ files, active }`, or the older `{ paths, active }` (this folder only). */
export function readSavedTabs(root: string): SavedTabs | null {
  try {
    const v = JSON.parse(localStorage.getItem(tabsKey(root)) ?? 'null');
    const active = typeof v?.active === 'string' ? v.active : 'chat';
    // per entry: one bad tab is dropped, the others keep their place (an active id that was dropped falls back in restore)
    if (Array.isArray(v?.tabs)) return { tabs: v.tabs.filter((t: unknown) => isSavedTab(t)), active };
    if (Array.isArray(v?.files) && v.files.every(isSavedFile)) return { tabs: v.files.map((file: SavedFile) => ({ file })), active };
    if (Array.isArray(v?.paths) && v.paths.every((p: unknown) => typeof p === 'string')) return { tabs: v.paths.map((path: string) => ({ file: { path } })), active };
    return null;
  } catch {
    return null;
  }
}
