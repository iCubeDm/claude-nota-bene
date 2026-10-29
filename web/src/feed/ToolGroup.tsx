import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import type { FeedItem } from '@/store/feed.ts';
import { ToolLine } from './ToolLine.tsx';
import { useContext } from 'react';
import { FeedScope } from './scope.ts';
import { scopedId, selectGroupOpen, selectToolCommentCounts, toggleGroup } from './uiSlice.ts';

type Tool = Extract<FeedItem, { kind: 'tool' }>;

/**
 * Consecutive actions of the agent and its subagents as one collapsed line, "N actions" (user, 2026-10-27: no list of
 * tools, the user sees them when it is opened). Open: every action line, each expandable to its command and output.
 * While the turn still runs and this is the last thing in the feed, the latest action shows under the head. Open state
 * lives in `feedUi`, keyed by the first action's id; folded, the head counts the comments on its actions (R-M7-20).
 */
export function ToolGroup({ items, live }: { items: Tool[]; live: boolean }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const agent = useContext(FeedScope).agent;
  const open = useAppSelector((s) => selectGroupOpen(s, scopedId(agent, items[0]!.id)));
  const counts = useAppSelector(selectToolCommentCounts);
  const comments = items.reduce((n, it) => n + (counts[scopedId(agent, it.id)] ?? 0), 0);
  const errors = items.filter((it) => it.result?.isError).length;
  const last = items[items.length - 1]!;
  return (
    <div data-kind="tool-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => dispatch(toggleGroup(scopedId(agent, items[0]!.id)))}
        data-anchor-skip
        className="my-2.5 block w-full cursor-pointer truncate rounded-sm text-left font-mono text-[11.5px] leading-normal text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {t('nActions', items.length)}
        {errors > 0 && <span className="text-destructive"> · {t('nErrors', errors)}</span>}
        {!open && comments > 0 && <span className="text-nb-accent"> · {t('nComments', comments)}</span>}
      </button>
      {open ? (
        <div className="border-l border-border-soft pl-3">
          {items.map((it) => <ToolLine key={`tool:${it.id}`} item={it} />)}
        </div>
      ) : (
        live && <div className="pl-3"><ToolLine key={`tool:${last.id}`} item={last} /></div>
      )}
    </div>
  );
}
