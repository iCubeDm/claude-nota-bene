import type { ReactNode } from 'react';
import { useAppSelector } from '@/store/store.ts';
import { FileView } from '@/files/FileView.tsx';
import { selectTabs } from './slice.ts';

/**
 * All panes stay mounted; the inactive ones are `hidden`. The chat pane is therefore the same element
 * across tab switches (comment anchors, HighlightLayer, SelectionButton's scroll listener and the feed autoscroll rely on it).
 */
export function Panes({ chat }: { chat: ReactNode }) {
  const { open, active, rootGen } = useAppSelector(selectTabs);
  return (
    <>
      <main data-chat-pane data-pane="chat" hidden={active !== 'chat'} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {chat}
      </main>
      {open.map((tab) =>
        tab.kind === 'file' ? <FileView key={`${rootGen}:${tab.id}`} path={tab.path} src={tab.src} refName={tab.ref} active={active === tab.id} /> : null,
      )}
    </>
  );
}
