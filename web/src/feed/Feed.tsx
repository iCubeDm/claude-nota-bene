import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { refClick } from '@/refs/refs.ts';
import { selectFeed, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { Markdown } from './Markdown.tsx';
import { CompactingLine, DoneLine, IdleCompactLine, MarkerLine, NoticeLine } from './DoneLine.tsx';
import { PlanCard } from './PlanCard.tsx';
import { PermissionCard } from './PermissionCard.tsx';
import { ToolGroup } from './ToolGroup.tsx';
import { ToolLine } from './ToolLine.tsx';
import { UserMessage } from './UserMessage.tsx';

/** Farther from the end than this, the "jump to the latest" button shows. */
const AWAY_PX = 200;

/** The chat transcript: one element per FeedItem, auto-scrolling only while the reader is at the bottom. */
export function Feed() {
  const { items, compacting, busy } = useAppSelector(selectFeed);
  const t = useT();
  const dispatch = useAppDispatch();
  const root = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastLen = useRef(0);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false); // something new arrived below while away
  const chatPane = () => root.current?.closest<HTMLElement>('[data-chat-pane]') ?? null;

  // The scroll container is the nearest ancestor marked data-chat-pane (App's <main>).
  useLayoutEffect(() => {
    const pane = root.current?.closest<HTMLElement>('[data-chat-pane]');
    if (!pane) return;
    const onScroll = () => {
      const left = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      stick.current = left < 80;
      setAway(left > AWAY_PX);
      if (left <= AWAY_PX) setUnread(false);
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
    } else if (pane) setUnread(true);
  }, [items, compacting]);

  const toLatest = () => {
    const p = chatPane();
    if (!p) return;
    stick.current = true; // the items that land during the smooth scroll follow it down
    p.scrollTo({ top: p.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div ref={root} onClick={(e) => refClick(e, dispatch)}>
      {items.length === 0 && (
        <div data-kind="empty" className="py-6 text-center text-sm text-muted-foreground">
          {t('emptyChat')}
        </div>
      )}
      {items.map((it, i) => {
        if (it.kind === 'tool') {
          // a run of consecutive actions is drawn once, by its first item; one action alone stays a plain line
          if (items[i - 1]?.kind === 'tool') return null;
          let end = i + 1;
          while (items[end]?.kind === 'tool') end++;
          if (end - i === 1) return <ToolLine key={`tool:${it.id}:${i}`} item={it} />;
          const run = items.slice(i, end) as Extract<typeof it, { kind: 'tool' }>[];
          return <ToolGroup key={`group:${it.id}:${i}`} items={run} live={busy && end === items.length} />;
        }
        switch (it.kind) {
          case 'user':
            return it.idle ? <IdleCompactLine key={it.id} item={it} /> : <UserMessage key={it.id} item={it} />;
          case 'assistant':
            return (
              <div key={it.id} data-kind="assistant" data-item-id={it.id} data-final={String(it.final)} className="my-2.5">
                <Markdown text={it.text} final={it.final} />
              </div>
            );
          case 'done':
            return <DoneLine key={`done:${i}`} item={it} />;
          case 'permission':
            return it.toolName === 'ExitPlanMode' && typeof it.input.plan === 'string' ? <PlanCard key={it.id} item={it} /> : <PermissionCard key={it.id} item={it} />;
          case 'marker':
            return <MarkerLine key={`marker:${i}`} item={it} />;
          case 'notice':
            return <NoticeLine key={`notice:${i}`} item={it} />;
        }
      })}
      {compacting !== null && <CompactingLine since={compacting} />}
      {away && (
        // sticky inside the scrolling pane: it stays at the pane's bottom edge without taking room in the transcript
        <div data-anchor-skip className="pointer-events-none sticky bottom-3 flex h-0 justify-end">
          <button
            type="button"
            onClick={toLatest}
            aria-label={t('toLatest')}
            title={t('toLatest')}
            data-unread={unread || undefined}
            className="pointer-events-auto relative -translate-y-full rounded-full border border-border-soft bg-popover/90 p-2 text-muted-foreground shadow-md backdrop-blur hover:text-foreground"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5v14M5 12l7 7 7-7" /></svg>
            {unread && <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-nb-accent" />}
          </button>
        </div>
      )}
    </div>
  );
}
