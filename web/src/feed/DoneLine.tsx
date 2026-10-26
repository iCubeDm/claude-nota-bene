import { useEffect, useState } from 'react';
import { fmtK } from '@/lib/format.ts';
import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { useAppSelector } from '@/store/store.ts';
import { selectIdleCompact } from '@/controls/slice.ts';
import { compactProgress, expectedCompactMs, mmss } from './compactTiming.ts';
import { timeOf } from './UserMessage.tsx';

const BASE = 'mt-4 border-t border-dashed border-border-soft pt-1 font-mono text-[10.5px]';
const LINE = `${BASE} text-muted-foreground`;

export function DoneLine({ item }: { item: Extract<FeedItem, { kind: 'done' }> }) {
  const t = useT();
  const time = item.ts === 0 ? '' : ` · ${timeOf(item.ts)}`;
  return (
    <div data-kind="done" className={LINE}>
      {t(item.status)} · {item.secs}{t('secondsSuffix')}{time}
      {item.error ? <span className="whitespace-pre-wrap text-destructive"> · {item.error}</span> : null}
    </div>
  );
}

export function NoticeLine({ item }: { item: Extract<FeedItem, { kind: 'notice' }> }) {
  const t = useT();
  return (
    <div data-kind="notice" className={LINE}>
      {t('resumed', item.text)}
    </div>
  );
}

export function MarkerLine({ item }: { item: Extract<FeedItem, { kind: 'marker' }> }) {
  const t = useT();
  const at = item.ts === 0 ? '' : timeOf(item.ts);
  return (
    <div data-kind="marker" className={item.what === 'compactFailed' ? `${BASE} whitespace-pre-wrap text-destructive` : LINE}>
      {item.what === 'compacted' ? t('compacted', fmtK(item.pre ?? 0), at, item.ms ? mmss(item.ms) : '')
        : item.what === 'compactFailed' ? t('compactFailed', item.error ?? '', at)
        : t('cleared', at)}
    </div>
  );
}

/** The server's own /compact after a quiet stretch: a line, never a bubble the user did not write. */
export function IdleCompactLine({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  const t = useT();
  const idle = useAppSelector(selectIdleCompact);
  return (
    <div data-kind="idle-compact" data-item-id={item.id} className={LINE}>
      {t('idleLine', idle ? String(idle.minutes) : '', item.ts === 0 ? '' : timeOf(item.ts))}
    </div>
  );
}

/**
 * The live line while a compaction runs: elapsed time and an estimated bar (see compactTiming.ts). `since` is the
 * server's ts of the compacting frame, so a reload mid-compaction keeps the elapsed time.
 */
export function CompactingLine({ since, now = Date.now }: { since: number; now?: () => number }) {
  const t = useT();
  const [at, setAt] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setAt(now()), 500);
    return () => clearInterval(id);
  }, [now]);
  const [expected] = useState(expectedCompactMs); // fixed for this compaction
  const elapsed = Math.max(0, at - since);
  const pct = Math.round(compactProgress(elapsed, expected) * 100);
  return (
    <div data-kind="compacting" className={LINE} title={t('compactingTip')}>
      <div>{t('compacting', mmss(elapsed), mmss(expected))}</div>
      <div
        role="progressbar"
        aria-label={t('compacting', mmss(elapsed), mmss(expected))}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-1 h-[3px] max-w-[320px] overflow-hidden rounded-full bg-border"
      >
        <div
          data-part="fill"
          className="h-full rounded-full bg-[var(--nb-accent,oklch(0.70_0.20_60))] transition-[width] duration-500 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
