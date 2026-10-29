import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'react-redux';
import { sendBatch } from './comments/send.ts';
import { selectConn, useAppDispatch, useAppSelector, type AppStore } from './store/store.ts';
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
import { TasksDrawer } from './tasks/TasksDrawer.tsx';
import { Panes } from './tabs/Panes.tsx';
import { TabStrip } from './tabs/TabStrip.tsx';
import { Header } from './shell/Header.tsx';
import { LeftStrip, RightStrip } from './shell/ToolStrip.tsx';
import { OneTab } from './shell/OneTab.tsx';
import { Toasts } from './shell/Toasts.tsx';
import { useFavicon } from './shell/Favicon.ts';
import { RecentFiles } from '@/files/RecentFiles.tsx';
import { installKeymap } from './shell/keymap.ts';

export function App() {
  const dispatch = useAppDispatch();
  const store = useStore() as AppStore;
  useEffect(() => installKeymap(store), [store]);
  useFavicon();
  useActivity();
  const sendPanel = useCallback(() => void dispatch(sendBatch(false)), [dispatch]);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const close = useCallback(() => setPending(null), []);
  // another root: the tree's loaded folders belong to the old one (its open/closed state is in the store and stays)
  const rootGen = useAppSelector((s) => selectTabs(s).rootGen);
  // another tab owns the window (M7-15): the app stays mounted but inert under the overlay
  const conn = useAppSelector(selectConn);
  const blocked = conn === 'occupied' || conn === 'taken';
  return (
    <TooltipProvider>
      <div className="contents" inert={blocked}>
      <Header />
      {/*
        IntelliJ-style (R-M6-3): the strips and their panels run the full height under the header; an open panel is
        docked and narrows the middle column (tabs, panes, composer) instead of covering it.
      */}
      <div className="flex min-h-0 flex-1">
        <LeftStrip />
        <FileTree key={rootGen} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TabStrip />
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
            <TasksDrawer />
          </div>
          <Footer />
        </div>
        <CommentsPanel onSend={sendPanel} />
        <RightStrip />
      </div>
      <SelectionButton onComment={setPending} />
      {pending && <CommentPopup pending={pending} onClose={close} />}
      <CommentCardPopover />
      <Toasts />
      <RecentFiles />
      </div>
      <OneTab />
    </TooltipProvider>
  );
}
