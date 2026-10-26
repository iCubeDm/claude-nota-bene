import { useCallback, useState } from 'react';
import { sendBatch } from './comments/send.ts';
import { useAppDispatch, useAppSelector } from './store/store.ts';
import { selectTabs } from './tabs/slice.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentCardPopover } from './comments/CommentCard.tsx';
import { HighlightLayer } from './comments/HighlightLayer.tsx';
import { CommentsPanel } from './comments/CommentsPanel.tsx';
import { CommentPopup } from './comments/CommentPopup.tsx';
import { SelectionButton, type PendingSelection } from './comments/SelectionButton.tsx';
import { FileTree } from './files/FileTree.tsx';
import { Feed } from './feed/Feed.tsx';
import { Footer } from './shell/Footer.tsx';
import { useActivity } from './controls/useActivity.ts';
import { Panes } from './tabs/Panes.tsx';
import { TabStrip } from './tabs/TabStrip.tsx';
import { Header } from './shell/Header.tsx';
import { LeftStrip, RightStrip } from './shell/ToolStrip.tsx';
import { Toasts } from './shell/Toasts.tsx';
import { useFavicon } from './shell/Favicon.ts';

export function App() {
  const dispatch = useAppDispatch();
  useFavicon();
  useActivity();
  const sendPanel = useCallback(() => void dispatch(sendBatch(false)), [dispatch]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const close = useCallback(() => setPending(null), []);
  // another root: the tree's loaded folders belong to the old one (its open/closed state is in the store and stays)
  const rootGen = useAppSelector((s) => selectTabs(s).rootGen);
  return (
    <TooltipProvider>
      <Header />
      {/* the strips run the full height between header and footer; the tabs belong to the work area */}
      <div className="flex min-h-0 flex-1">
        <LeftStrip />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabStrip />
          {/* the panels are absolute sheets inside this box: each slides out next to its strip, over the work area */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <Panes
              chat={
                <>
                  <div
                    id="items"
                    className="nb-card nb-prose px-10 pt-5 pb-7 text-[15px] leading-[1.625] text-foreground/90"
                  >
                    <Feed />
                  </div>
                  <HighlightLayer />
                </>
              }
            />
            <FileTree key={rootGen} />
            <CommentsPanel onSend={sendPanel} />
          </div>
        </div>
        <RightStrip />
      </div>
      <SelectionButton onComment={setPending} />
      {pending && <CommentPopup pending={pending} onClose={close} />}
      <CommentCardPopover />
      <Footer />
      <Toasts />
    </TooltipProvider>
  );
}
