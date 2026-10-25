import { fmtK } from '@/lib/format.ts';
import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
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
  if (item.tone === 'error') {
    return (
      <div data-kind="notice" role="alert" className={`${BASE} whitespace-pre-wrap text-destructive`}>
        {t('serverError', item.where)}: {item.text}
      </div>
    );
  }
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
    <div data-kind="marker" className={LINE}>
      {item.what === 'compacted' ? t('compacted', fmtK(item.pre ?? 0), at) : t('cleared', at)}
    </div>
  );
}
