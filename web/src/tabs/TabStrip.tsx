import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectPendingCountByPath } from '@/comments/slice.ts';
import { FileIcon } from '@/files/FileIcon.tsx';
import { fileKey } from '@/files/sources.ts';
import { SourceChip } from '@/files/SourcePicker.tsx';
import { selectSession, useAppDispatch, useAppSelector, useMedia } from '@/store/store.ts';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu.tsx';
import { activate, closeAll, closeOthers, closeRight, closeTab, selectTabs, type Tab } from './slice.ts';
import { TabsMenu } from './TabsMenu.tsx';

export const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width={size} height={size} className="flex-none">{children}</svg>
);
export const ICONS = {
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  dir: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  comments: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M8 9h8M8 13h5" /></>,
};

const basename = (p: string) => p.split('/').pop() || p;

/** After a pick in a list (▾, Cmd+E): the focus goes to the tab it activated, not back to a now-hidden pane. */
export const focusTab = (id: string) =>
  requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[role="tablist"] [data-tab]')].find((n) => n.dataset.tab === id)?.focus({ preventScroll: true }));

function TabItem({ tab, active, last, playing }: { tab: Tab; active: boolean; last: boolean; playing: boolean }) {
  const t = useT();
  const d = useAppDispatch();
  const badge = useAppSelector((s) => (tab.kind === 'file' ? selectPendingCountByPath(s)[fileKey(tab.path, tab.ref)] ?? 0 : 0));
  const title = useAppSelector((s) => selectSession(s)?.title ?? null);
  const label = tab.kind === 'chat' ? title || t('chat') : basename(tab.path);
  const isChat = tab.kind === 'chat';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          tabIndex={active ? 0 : -1}
          aria-selected={active}
          data-tab={tab.id}
          data-playing={playing || undefined}
          title={tab.kind === 'file' ? (tab.ref ? `${tab.path} @ ${tab.ref}` : tab.path) : title ?? t('chatTip')}
          onClick={() => d(activate(tab.id))}
          onAuxClick={(e) => {
            if (e.button === 1 && !isChat) { e.preventDefault(); d(closeTab(tab.id)); }
          }}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d(activate(tab.id)); }
          }}
          className={`group flex h-7 max-w-[260px] flex-none cursor-pointer items-center gap-1.5 rounded-lg pr-1.5 pl-2.5 text-[12.5px] font-medium whitespace-nowrap hover:bg-muted/50 hover:text-foreground ${active ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}
        >
          <span className="hidden size-1.5 flex-none animate-pulse rounded-full bg-primary group-data-[playing=true]:inline-block" />
          {tab.kind === 'chat' ? <Svg>{ICONS.chat}</Svg> : <FileIcon path={tab.path} />}
          <span className="truncate">{label}</span>
          {tab.kind === 'file' && tab.ref && <SourceChip name={tab.ref} />}
          {badge > 0 && <span data-badge className="rounded-full bg-nb-accent/[.18] px-1.5 text-[10px] font-semibold leading-4 text-nb-accent">{badge}</span>}
          {!isChat && (
            <button
              type="button"
              aria-label={t('close')}
              title={t('close')}
              onClick={(e) => { e.stopPropagation(); d(closeTab(tab.id)); }}
              className="grid size-[18px] place-items-center rounded-[5px] opacity-50 hover:bg-muted hover:opacity-100"
            >
              <Svg size={10}><path d="M18 6 6 18M6 6l12 12" /></Svg>
            </button>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {!isChat && <ContextMenuItem onSelect={() => d(closeTab(tab.id))}>{t('close')}</ContextMenuItem>}
        <ContextMenuItem onSelect={() => d(closeOthers(tab.id))}>{t('closeOthers')}</ContextMenuItem>
        {!isChat && !last && <ContextMenuItem onSelect={() => d(closeRight(tab.id))}>{t('closeRight')}</ContextMenuItem>}
        <ContextMenuItem onSelect={() => d(closeAll())}>{t('closeAll')}</ContextMenuItem>
        {tab.kind === 'file' && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(tab.path)}>{t('copyPath')}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Tab overflow, IntelliJ-style (M6-12): no scrollbar; the wheel scrolls the strip sideways, the active tab is scrolled
 * into view, and "▾" at the right end lists the hidden tabs and all tabs.
 */
export function TabStrip() {
  const { open, active } = useAppSelector(selectTabs);
  const media = useMedia();
  const playing = useSyncExternalStore(media.subscribe, () => media.playing());
  const strip = useRef<HTMLDivElement>(null);
  // after a switch, an open or a close (not on a resize: that would undo the user's own scroll of the strip)
  useEffect(() => {
    [...(strip.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])].find((n) => n.dataset.tab === active)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, open.length]);
  return (
    <div className="flex h-10 flex-none items-center gap-1 border-b border-border-soft bg-chrome pr-1.5 pl-2">
      <div
        ref={strip}
        role="tablist"
        onWheel={(e) => {
          // a vertical wheel scrolls the strip sideways (a trackpad's own horizontal swipe already does)
          // deltaMode 1 (lines, Firefox's mouse wheel): about 16 px a line
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
        }}
        className="nb-no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {open.map((tab, i) => (
          // the dot marks a background tab that still plays; the active tab shows its own player
          <TabItem key={tab.id} tab={tab} active={tab.id === active} last={i === open.length - 1} playing={tab.id === playing && tab.id !== active} />
        ))}
      </div>
      <TabsMenu strip={strip} />
    </div>
  );
}
