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
  agent: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  diagram: <><rect x="3" y="3" width="7" height="6" rx="1" /><rect x="14" y="15" width="7" height="6" rx="1" /><path d="M6.5 9v3.5a2 2 0 0 0 2 2H14M10 18H7a1 1 0 0 1-1-1" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
};

/** A tab's icon: the chat, Settings and a diagram have their own, a file its type's. */
export const TabIcon = ({ tab }: { tab: Tab }) =>
  tab.kind === 'file' ? <FileIcon path={tab.path} /> : <Svg>{ICONS[tab.kind]}</Svg>;

const basename = (p: string) => p.split('/').pop() || p;

/**
 * After a pick in a list (▾, Cmd+E): the tab it activated is scrolled into view (also when it was active already, so
 * the activation effect did not run) and takes the focus, not a now-hidden pane.
 */
export const focusTab = (id: string) =>
  requestAnimationFrame(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [data-tab]')].find((n) => n.dataset.tab === id);
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    el?.focus({ preventScroll: true });
  });

function TabItem({ tab, active, last, playing }: { tab: Tab; active: boolean; last: boolean; playing: boolean }) {
  const t = useT();
  const d = useAppDispatch();
  const badge = useAppSelector((s) => (tab.kind === 'file' ? selectPendingCountByPath(s)[fileKey(tab.path, tab.ref)] ?? 0 : 0));
  const title = useAppSelector((s) => selectSession(s)?.title ?? null);
  const label = tab.kind === 'chat' ? title || t('chat') : tab.kind === 'settings' ? t('settings') : tab.kind === 'diagram' ? tab.title || t('diagramTab') : tab.kind === 'agent' ? tab.title || t('agentTab') : basename(tab.path);
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
          title={tab.kind === 'file' ? (tab.ref ? `${tab.path} @ ${tab.ref}` : tab.path) : tab.kind === 'diagram' ? `${t('diagramTab')}: ${tab.title}` : tab.kind === 'agent' ? `${t('agentTab')}: ${tab.title}` : title ?? t('chatTip')}
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
          <TabIcon tab={tab} />
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
