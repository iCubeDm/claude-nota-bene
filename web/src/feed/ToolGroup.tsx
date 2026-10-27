import { useState } from 'react';
import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { ToolLine } from './ToolLine.tsx';

type Tool = Extract<FeedItem, { kind: 'tool' }>;

/**
 * Consecutive actions of the agent and its subagents as one collapsed line, "N actions" (user, 2026-10-27: no list of
 * tools, the user sees them when it is opened). Open: every action line, each expandable to its command and output.
 * While the turn still runs and this is the last thing in the feed, the latest action shows under the head.
 */
export function ToolGroup({ items, live }: { items: Tool[]; live: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const errors = items.filter((it) => it.result?.isError).length;
  const last = items[items.length - 1]!;
  return (
    <div data-kind="tool-group">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="my-2.5 block w-full cursor-pointer truncate rounded-sm text-left font-mono text-[11.5px] leading-normal text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {t('nActions', items.length)}
        {errors > 0 && <span className="text-destructive"> · {t('nErrors', errors)}</span>}
      </button>
      {open ? (
        <div className="border-l border-border-soft pl-3">
          {items.map((it, i) => <ToolLine key={`tool:${it.id}:${i}`} item={it} />)}
        </div>
      ) : (
        live && <div className="pl-3"><ToolLine key={`tool:${last.id}`} item={last} /></div>
      )}
    </div>
  );
}
