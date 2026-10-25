import { useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { SelectionButton, type PendingSelection } from './comments/SelectionButton.tsx';
import { Feed } from './feed/Feed.tsx';
import { Footer } from './shell/Footer.tsx';
import { Header } from './shell/Header.tsx';

export function App() {
  // TEMP M1-10: renders CommentPopup from this; drop data-pending-quote then
  const [pending, setPending] = useState<PendingSelection | null>(null);
  return (
    <TooltipProvider>
      <Header />
      {/* TEMP M1-10 */}
      <main data-chat-pane data-pending-quote={pending?.anchor.quote} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        <div
          id="items"
          className="mx-auto mt-4 mb-6 max-w-[860px] rounded-xl border border-border-soft bg-card px-10 pt-5 pb-7 text-[15px] leading-[1.625] text-foreground/90 shadow-[0_1px_3px_rgba(0,0,0,0.25)]"
        >
          <Feed />
        </div>
      </main>
      <SelectionButton onComment={setPending} />
      <Footer />
    </TooltipProvider>
  );
}
