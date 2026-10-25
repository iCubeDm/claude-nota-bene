import { useCallback, useState } from 'react';
import { sendBatch } from './comments/send.ts';
import { useAppDispatch } from './store/store.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentCardPopover } from './comments/CommentCard.tsx';
import { HighlightLayer } from './comments/HighlightLayer.tsx';
import { CommentsPanel } from './comments/CommentsPanel.tsx';
import { CommentPopup } from './comments/CommentPopup.tsx';
import { SelectionButton, type PendingSelection } from './comments/SelectionButton.tsx';
import { Feed } from './feed/Feed.tsx';
import { Footer } from './shell/Footer.tsx';
import { Header } from './shell/Header.tsx';

export function App() {
  const dispatch = useAppDispatch();
  const sendPanel = useCallback(() => void dispatch(sendBatch(false)), [dispatch]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const close = useCallback(() => setPending(null), []);
  return (
    <TooltipProvider>
      <Header />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <main data-chat-pane className="grid-pane relative min-h-0 flex-1 overflow-auto">
          <div
            id="items"
            className="mx-auto mt-4 mb-6 max-w-[860px] rounded-xl border border-border-soft bg-card px-10 pt-5 pb-7 text-[15px] leading-[1.625] text-foreground/90 shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
          >
            <Feed />
          </div>
          <HighlightLayer />
        </main>
        <CommentsPanel onSend={sendPanel} />
      </div>
      <SelectionButton onComment={setPending} />
      {pending && <CommentPopup pending={pending} onClose={close} />}
      <CommentCardPopover />
      <Footer />
    </TooltipProvider>
  );
}
