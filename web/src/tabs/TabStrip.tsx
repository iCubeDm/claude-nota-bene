import { useSyncExternalStore, type ReactNode } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectPendingCountByPath } from '@/comments/slice.ts';
import { AUDIO, IMAGE, VIDEO } from '@/files/kinds.ts';
import { revealInTree } from '@/tree/slice.ts';
import { useAppDispatch, useAppSelector, useMedia } from '@/store/store.ts';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu.tsx';
import { activate, closeAll, closeOthers, closeRight, closeTab, selectTabs, type Tab } from './slice.ts';

export const Svg = ({ children, size = 14 }: { children: ReactNode; size?: number }) => (
  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width={size} height={size} className="flex-none">{children}</svg>
);
export const ICONS = {
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  media: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></>,
  dir: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  img: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
};
export const iconForPath = (p: string) => (VIDEO.test(p) || AUDIO.test(p) ? ICONS.media : IMAGE.test(p) ? ICONS.img : ICONS.file);
const iconFor = (tab: Tab) => (tab.kind === 'chat' ? ICONS.chat : iconForPath(tab.path));

const basename = (p: string) => p.split('/').pop() || p;

function TabItem({ tab, active, last, playing }: { tab: Tab; active: boolean; last: boolean; playing: boolean }) {
  const t = useT();
  const d = useAppDispatch();
  const badge = useAppSelector((s) => (tab.kind === 'file' ? selectPendingCountByPath(s)[tab.path] ?? 0 : 0));
  const label = tab.kind === 'chat' ? t('chat') : basename(tab.path);
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
          title={tab.kind === 'file' ? tab.path : undefined}
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
          <Svg>{iconFor(tab)}</Svg>
          <span className="truncate">{label}</span>
          {badge > 0 && <span data-badge className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">{badge}</span>}
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
            <ContextMenuItem onSelect={() => d(revealInTree(tab.path))}>{t('revealInTree')}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function TabStrip() {
  const { open, active } = useAppSelector(selectTabs);
  const media = useMedia();
  const playing = useSyncExternalStore(media.subscribe, () => media.playing());
  return (
    <div role="tablist" className="flex h-10 flex-none items-center gap-1 overflow-x-auto border-b border-border-soft bg-chrome px-2">
      {open.map((tab, i) => (
        // the dot marks a background tab that still plays; the active tab shows its own player
        <TabItem key={tab.id} tab={tab} active={tab.id === active} last={i === open.length - 1} playing={tab.id === playing && tab.id !== active} />
      ))}
    </div>
  );
}
