import type { ReactNode } from 'react';
import { useAppSelector } from '@/store/store.ts';
import { selectTabs } from './slice.ts';

/**
 * All panes stay mounted; the inactive ones are `hidden`. The chat pane is therefore the same element
 * across tab switches (comment anchors, HighlightLayer, SelectionButton's scroll listener and the feed autoscroll rely on it).
 */
export function Panes({ chat }: { chat: ReactNode }) {
  const { open, active } = useAppSelector(selectTabs);
  return (
    <>
      <main data-chat-pane data-pane="chat" hidden={active !== 'chat'} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {chat}
      </main>
      {open.map((tab) =>
        tab.kind === 'file' ? (
          // placeholder until M3-08 (FileView)
          <div key={tab.id} data-pane={tab.id} hidden={active !== tab.id} className="grid-pane relative min-h-0 flex-1 overflow-auto p-4 font-mono text-xs text-muted-foreground">
            {tab.path}
          </div>
        ) : null,
      )}
    </>
  );
}
