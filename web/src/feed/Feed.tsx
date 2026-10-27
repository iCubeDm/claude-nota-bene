import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { refClick } from '@/refs/refs.ts';
import { selectFeed, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { Markdown } from './Markdown.tsx';
import { CompactingLine, DoneLine, IdleCompactLine, MarkerLine, NoticeLine } from './DoneLine.tsx';
import { EarlierButton } from './EarlierButton.tsx';
import { PlanCard } from './PlanCard.tsx';
import { PermissionCard } from './PermissionCard.tsx';
import { ToolGroup } from './ToolGroup.tsx';
import { ToolLine } from './ToolLine.tsx';
import { UserMessage } from './UserMessage.tsx';

/** Farther from the end than this, the "jump to the latest" button shows. */
const AWAY_PX = 200;

/** How long after a prepend the reader's anchor is kept: late images and diagrams above it grow the page. */
const ANCHOR_MS = 1000;

/** An element the reader was looking at before an archived segment went in, and where it stood in the pane. */
type Anchor = { el: HTMLElement; offset: number };
const offsetIn = (pane: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top;

/** The chat transcript: one element per FeedItem, auto-scrolling only while the reader is at the bottom. */
export function Feed() {
  const { items, compacting, busy, epoch, earlier } = useAppSelector(selectFeed);
  const t = useT();
  const dispatch = useAppDispatch();
  const root = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastLen = useRef(0);
  /** set right before an archived segment is prepended: what the reader sees stays where it is; null otherwise */
  const prepending = useRef<{ anchor: Anchor | null } | null>(null);
  /** ends the short window in which the anchor is re-applied (resize, timeout, the reader scrolling) */
  const settling = useRef<(() => void) | null>(null);
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
    // an archived segment went in above: keep what the reader looks at in place, and neither scroll to the end nor
    // mark it as new below
    const pre = prepending.current;
    prepending.current = null;
    if (pre !== null) {
      lastLen.current = items.length;
      if (pane && pre.anchor) hold(pane, pre.anchor);
      return;
    }
    // a new user message always scrolls down, like the prototype; everything else only when already near the bottom
    const sentNow = items.length > lastLen.current && items[items.length - 1]?.kind === 'user';
    lastLen.current = items.length;
    if (pane && (stick.current || sentNow)) {
      pane.scrollTop = pane.scrollHeight;
      stick.current = true;
    } else if (pane) setUnread(true);
    // `earlier`: a page that added nothing new (all kept items, or a 404) still ends its prepend here
  }, [items, compacting, earlier]);

  useLayoutEffect(() => () => settling.current?.(), []);

  /**
   * Puts `anchor` back where it was, now and for ANCHOR_MS after: images and diagrams in the new content load late and
   * grow it above the reader. Ends at the first wheel, touch, key, pointer press or scroll that is not ours.
   */
  const hold = (pane: HTMLElement, anchor: Anchor) => {
    settling.current?.();
    let ours = NaN;
    const apply = () => {
      if (!anchor.el.isConnected) return;
      const delta = offsetIn(pane, anchor.el) - anchor.offset;
      if (!delta) return;
      pane.scrollTop += delta;
      ours = pane.scrollTop;
    };
    const until = Date.now() + ANCHOR_MS;
    const onResize = () => (Date.now() >= until ? stop() : apply());
    const onScroll = () => {
      if (pane.scrollTop !== ours) stop();
    };
    const events = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'] as const;
    const ro = typeof ResizeObserver === 'undefined' || !root.current ? null : new ResizeObserver(onResize);
    if (root.current) ro?.observe(root.current);
    const timer = setTimeout(() => stop(), ANCHOR_MS);
    function stop() {
      ro?.disconnect();
      clearTimeout(timer);
      pane.removeEventListener('scroll', onScroll);
      for (const ev of events) pane.removeEventListener(ev, stop);
      if (settling.current === stop) settling.current = null;
    }
    apply();
    pane.addEventListener('scroll', onScroll);
    for (const ev of events) pane.addEventListener(ev, stop, { passive: true });
    settling.current = stop;
  };

  const beforePrepend = () => {
    const p = chatPane();
    // the first item with a stable key (the lines keyed by position, e.g. markers, are remounted by a prepend)
    const kids = [...(root.current?.children ?? [])].filter((c) => !c.hasAttribute('data-earlier')) as HTMLElement[];
    const el = kids.find((c) => c.hasAttribute('data-item-id') || c.querySelector('[data-item-id]')) ?? kids[0];
    prepending.current = { anchor: p && el ? { el, offset: offsetIn(p, el) } : null };
  };

  const toLatest = () => {
    const p = chatPane();
    if (!p) return;
    stick.current = true; // the items that land during the smooth scroll follow it down
    p.scrollTo({ top: p.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div ref={root} onClick={(e) => refClick(e, dispatch)}>
      {/* keyed by the feed's epoch: a replay or /clear starts it afresh (no loading or failure left over) */}
      <EarlierButton key={epoch} beforePrepend={beforePrepend} />
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
