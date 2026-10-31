import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SubagentView } from '@nota-bene/shared';
import { emptyFeed, reduce, type FeedItem, type FeedState } from '../store/feed.ts';
import type { AppThunk, RootState } from '../store/store.ts';
import { openAgent } from '../tabs/slice.ts';
import { apiFetch } from '@/net/auth.ts';

/**
 * Subagent conversations (M2 step 1), by the tool-use id of the Agent call that started each. Fetched whole from
 * `GET /subagent` and reduced from an empty feed by the same pure `reduce()` as the main chat; kept apart from the main
 * `feed` slice, which they never touch. `session`: the conversation they were read for (an entry of another session is
 * not shown). `status`: loading (first fetch, nothing yet), ok, gone (404 / 409: not in this session), error.
 */
export type SubagentEntry = {
  tool: string; session: string; status: 'loading' | 'ok' | 'gone' | 'error';
  feed: FeedState; running: boolean; type: string; description: string; error?: string;
  /** what the last accepted answer looked like: an identical refetch changes nothing (no re-render, no repaint) */
  sig: string;
};
export type SubagentsState = { byTool: Record<string, SubagentEntry> };

const sigOf = (v: SubagentView): string => `${v.events.length}|${v.running}|${JSON.stringify(v.events[v.events.length - 1] ?? null)}`;
const blank = (tool: string, session: string): SubagentEntry => ({ tool, session, status: 'loading', feed: emptyFeed, running: false, type: '', description: '', sig: '' });

type Who = { tool: string; session: string };

export const subagentsSlice = createSlice({
  name: 'subagents',
  initialState: { byTool: {} } as SubagentsState,
  reducers: {
    /** A fetch starts: a first one (or one for another session) makes the entry; a refetch keeps what is shown. */
    requested: (s, a: PayloadAction<Who>) => {
      const cur = s.byTool[a.payload.tool];
      if (!cur || cur.session !== a.payload.session) s.byTool[a.payload.tool] = blank(a.payload.tool, a.payload.session);
    },
    loaded: (s, a: PayloadAction<Who & { view: SubagentView }>) => {
      const { tool, session, view } = a.payload;
      const cur = s.byTool[tool];
      if (!cur || cur.session !== session) return; // answered for a conversation that is no longer the entry's
      const sig = sigOf(view);
      if (cur.status === 'ok' && cur.sig === sig) return;
      s.byTool[tool] = {
        tool, session, status: 'ok', sig, running: view.running, type: view.type, description: view.description,
        feed: view.events.reduce(reduce, emptyFeed),
      };
    },
    failed: (s, a: PayloadAction<Who & { status: 'gone' | 'error'; error?: string }>) => {
      const { tool, session, status, error } = a.payload;
      const cur = s.byTool[tool];
      if (!cur || cur.session !== session) return;
      s.byTool[tool] = { ...cur, status, ...(error ? { error } : {}) }; // sig kept: the same answer later is no change
    },
  },
});

export const { requested, loaded, failed } = subagentsSlice.actions;

function isView(v: unknown): v is SubagentView {
  const o = v as Partial<SubagentView> | null;
  return !!o && Array.isArray(o.events) && typeof o.running === 'boolean' && typeof o.type === 'string' && typeof o.description === 'string';
}

/** What one fetch came to: the agent runs (poll again), ended, is not in this session, or failed; stale = dropped. */
export type FetchResult = 'running' | 'done' | 'gone' | 'error' | 'stale';

/**
 * Reads one subagent for the current session. 404 and 409 (not in this session: switched, or never was) are `gone`,
 * anything else wrong is `error` with a short text, never a silent empty pane. An answer arriving after the
 * conversation changed is dropped.
 */
export const fetchSubagent = (tool: string, signal?: AbortSignal): AppThunk<Promise<FetchResult>> => async (dispatch, getState) => {
  const session = getState().feed.session?.id;
  if (!session) return 'stale';
  dispatch(requested({ tool, session }));
  const stale = () => getState().feed.session?.id !== session || signal?.aborted === true;
  // an older server has no /subagent (its page fallback answers HTML): say what helps, not a JSON parse error
  const old = () => (dispatch(failed({ tool, session, status: 'error', error: OLD_SERVER })), 'error' as const);
  const { protocol } = getState().controls;
  if (protocol > 0 && protocol < AGENT_PROTOCOL) return old(); // known old: not even asked
  try {
    const r = await apiFetch(`/subagent?session=${encodeURIComponent(session)}&tool=${encodeURIComponent(tool)}`, { signal });
    if (stale()) return 'stale';
    if (r.status === 404 || r.status === 409) return (dispatch(failed({ tool, session, status: 'gone' })), 'gone');
    if (!r.ok) return (dispatch(failed({ tool, session, status: 'error', error: `HTTP ${r.status}` })), 'error');
    const body = await r.text();
    if (stale()) return 'stale';
    if (body.trimStart().startsWith('<')) return old();
    const v: unknown = JSON.parse(body);
    if (!isView(v)) return (dispatch(failed({ tool, session, status: 'error', error: 'bad answer' })), 'error');
    dispatch(loaded({ tool, session, view: v }));
    return v.running ? 'running' : 'done';
  } catch (e) {
    if (stale()) return 'stale';
    dispatch(failed({ tool, session, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return 'error';
  }
};

/** The entry for the CURRENT conversation; undefined when none was fetched for it. */
export const selectSubagent = (s: RootState, tool: string): SubagentEntry | undefined => {
  const e = s.subagents.byTool[tool];
  return e && e.session === s.feed.session?.id ? e : undefined;
};

/** The feed items a message source lives in: the main chat's, or a loaded subagent's (null: that subagent is not loaded). */
export const itemsOf = (s: RootState, agent?: string): FeedItem[] | null => {
  if (!agent) return s.feed.items;
  const e = selectSubagent(s, agent);
  // a failed poll keeps what was read: its comment cards must not turn into orphans for a network blip
  return e && (e.status === 'ok' || (e.status === 'error' && e.feed.items.length > 0)) ? e.feed.items : null;
};

/** The error of a read from a server without /subagent: the tab asks for a server restart. */
export const OLD_SERVER = 'old-server';

/** The first protocol whose server keeps `source.agent` on a comment's anchor (older ones drop it): below it, no comments in a subagent's tab. */
export const AGENT_PROTOCOL = 7;

/** Any Agent / Task call is a subagent's: `Agent` in current Claude Code, `Task` in older ones. */
export const isAgentTool = (name: string, toolKind?: string): boolean => toolKind === 'agent' || name === 'Agent' || name === 'Task';

/** Whether the Agent call has its tool_result, looked up in the chat and in every loaded subagent's feed (a nested call is in its parent's). */
export const selectToolResulted = (s: RootState, tool: string): boolean => {
  const has = (items: FeedItem[]) => items.some((it) => it.kind === 'tool' && it.id === tool && !!it.result);
  return has(s.feed.items) || Object.values(s.subagents.byTool).some((e) => has(e.feed.items));
};

/** What names a subagent in a batch line or a tab: its description, else the tab's title, else its type. */
export const agentName = (s: RootState, tool: string): string => {
  const e = selectSubagent(s, tool);
  if (e?.description) return e.description;
  const tab = s.tabs.open.find((t) => t.kind === 'agent' && t.tool === tool);
  if (tab?.kind === 'agent' && tab.title) return tab.title;
  // after a reload with the tab closed: the call itself is in the replayed chat (or in its parent subagent's feed)
  const call = s.feed.items.find((it) => it.kind === 'tool' && it.id === tool);
  const d = call?.kind === 'tool' ? call.input.description : undefined;
  return (typeof d === 'string' && d) || e?.type || '';
};

/** Opens (or shows) a subagent's tab by its Agent call's id, named by what is known of it (a jump from a comment card). */
export const openSubagentTab = (tool: string): AppThunk => (d, getState) => {
  d(openAgent({ tool, title: agentName(getState(), tool) }));
};
