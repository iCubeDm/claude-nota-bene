import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { AppThunk, RootState } from '../store/store.ts';
import type { FeedItem } from '../store/feed.ts';
import { isAgentTool, itemsOf } from '../subagent/slice.ts';

/**
 * Which action groups and tool panels are open (R-M7-19). In the store, not in the components, so a jump from a comment
 * card can open them before it resolves the range. A group is keyed by its FIRST tool id, which stays the same while
 * later actions join the run. Not persisted: a reload starts with everything folded.
 */
export type FeedUiState = { openTools: string[]; openGroups: string[] };

const initialState: FeedUiState = { openTools: [], openGroups: [] };

const toggle = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export const feedUiSlice = createSlice({
  name: 'feedUi',
  initialState,
  reducers: {
    toggleTool: (s, a: PayloadAction<string>) => ({ ...s, openTools: toggle(s.openTools, a.payload) }),
    toggleGroup: (s, a: PayloadAction<string>) => ({ ...s, openGroups: toggle(s.openGroups, a.payload) }),
    /** Opens a tool's panel and, when it sits in a group, that group (never closes either). */
    revealTool: (s, a: PayloadAction<{ tool: string; group: string | null }>) => {
      const { tool, group } = a.payload;
      if (!s.openTools.includes(tool)) s.openTools.push(tool);
      if (group && !s.openGroups.includes(group)) s.openGroups.push(group);
    },
  },
});

export const { toggleTool, toggleGroup, revealTool } = feedUiSlice.actions;

export const selectToolOpen = (s: RootState, id: string): boolean => s.feedUi.openTools.includes(id);
export const selectGroupOpen = (s: RootState, id: string): boolean => s.feedUi.openGroups.includes(id);

/** The anchor source id of a tool's panel (R-M7-18): the tool_use id is stable across a replay and a restart. */
export const TOOL_SRC = 'tool:';
export const toolSrcId = (toolId: string): string => TOOL_SRC + toolId;

/**
 * The key of a tool (or a group's first tool) in the fold state and the comment counts: its id, scoped by the subagent
 * whose conversation it is in. The SDK forwards a foreground subagent's tool calls into the main stream too, so the same
 * id can sit in the chat and in the agent's tab: each is its own line.
 */
export const scopedId = (agent: string | undefined, id: string): string => (agent ? `${agent}|${id}` : id);

/** The first tool id of the run of consecutive actions holding `toolId`; null when it is alone (no group) or not in the feed. */
export function groupOf(items: FeedItem[], toolId: string): string | null {
  const i = items.findIndex((it) => it.kind === 'tool' && it.id === toolId);
  if (i < 0) return null;
  // a subagent's call is a card of its own (Feed): it is in no run and ends the runs beside it
  const grouped = (it: FeedItem | undefined): boolean => it?.kind === 'tool' && !isAgentTool(it.name);
  if (!grouped(items[i])) return null;
  let first = i;
  while (grouped(items[first - 1])) first--;
  let end = i + 1;
  while (grouped(items[end])) end++;
  return end - first > 1 ? (items[first] as Extract<FeedItem, { kind: 'tool' }>).id : null;
}

/** Opens an action's panel and its group, read from the feed at call time (a jump from a comment card); an action not in the feed opens nothing. */
export const revealToolOf = (toolId: string, agent?: string): AppThunk => (d, getState) => {
  const items = itemsOf(getState(), agent) ?? [];
  if (!items.some((it) => it.kind === 'tool' && it.id === toolId)) return;
  const group = groupOf(items, toolId);
  d(revealTool({ tool: scopedId(agent, toolId), group: group && scopedId(agent, group) }));
};

/** Comments (pending and sent) per tool id, for the folded heads: a comment inside a closed panel is never invisible. */
export const selectToolCommentCounts = createSelector([(s: RootState) => s.comments.items], (items) => {
  const m: Record<string, number> = {};
  for (const c of items) {
    const src = c.anchor.source;
    if (src.kind === 'message' && src.id.startsWith(TOOL_SRC)) {
      const k = scopedId(src.agent, src.id.slice(TOOL_SRC.length));
      m[k] = (m[k] ?? 0) + 1;
    }
  }
  return m;
});

/** The furthest anchor end (in the panel's anchor text) per tool id: how much of a commented output must be rendered. */
export const selectToolAnchorEnds = createSelector([(s: RootState) => s.comments.items], (items) => {
  const m: Record<string, number> = {};
  for (const c of items) {
    const src = c.anchor.source;
    if (src.kind !== 'message' || !src.id.startsWith(TOOL_SRC) || !('end' in c.anchor)) continue;
    const id = scopedId(src.agent, src.id.slice(TOOL_SRC.length));
    m[id] = Math.max(m[id] ?? 0, c.anchor.end);
  }
  return m;
});
