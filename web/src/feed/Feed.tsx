import { useLayoutEffect, useRef } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectFeed, useAppSelector } from '@/store/store.ts';
import { Markdown } from './Markdown.tsx';
import { DoneLine, NoticeLine } from './DoneLine.tsx';
import { PermissionCard } from './PermissionCard.tsx';
import { ToolLine } from './ToolLine.tsx';
import { UserMessage } from './UserMessage.tsx';

/** The chat transcript: one element per FeedItem, auto-scrolling only while the reader is at the bottom. */
export function Feed() {
  const { items } = useAppSelector(selectFeed);
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastLen = useRef(0);

  // The scroll container is the nearest ancestor marked data-chat-pane (App's <main>).
  useLayoutEffect(() => {
    const pane = root.current?.closest<HTMLElement>('[data-chat-pane]');
    if (!pane) return;
    const onScroll = () => {
      stick.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
    };
    pane.addEventListener('scroll', onScroll);
    return () => pane.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const pane = root.current?.closest<HTMLElement>('[data-chat-pane]');
    // a new user message always scrolls down, like the prototype; everything else only when already near the bottom
    const sentNow = items.length > lastLen.current && items[items.length - 1]?.kind === 'user';
    lastLen.current = items.length;
    if (pane && (stick.current || sentNow)) {
      pane.scrollTop = pane.scrollHeight;
      stick.current = true;
    }
  }, [items]);

  return (
    <div ref={root}>
      {items.length === 0 && (
        <div data-kind="empty" className="py-6 text-center text-sm text-muted-foreground">
          {t('emptyChat')}
        </div>
      )}
      {items.map((it, i) => {
        switch (it.kind) {
          case 'user':
            return <UserMessage key={it.id} item={it} />;
          case 'assistant':
            return (
              <div key={it.id} data-kind="assistant" data-item-id={it.id} data-final={String(it.final)} className="my-2.5">
                <Markdown text={it.text} final={it.final} />
              </div>
            );
          case 'tool':
            return <ToolLine key={`tool:${it.id}:${i}`} item={it} />;
          case 'done':
            return <DoneLine key={`done:${i}`} item={it} />;
          case 'permission':
            return <PermissionCard key={it.id} item={it} />;
          case 'notice':
            return <NoticeLine key={`notice:${i}`} item={it} />;
        }
      })}
    </div>
  );
}
