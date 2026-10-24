import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { timeOf } from './UserMessage.tsx';

const LINE = 'mt-4 border-t border-dashed border-border-soft pt-1 font-mono text-[10.5px] text-muted-foreground';

export function DoneLine({ item }: { item: Extract<FeedItem, { kind: 'done' }> }) {
  const t = useT();
  const time = item.ts === 0 ? '' : ` · ${timeOf(item.ts)}`;
  return (
    <div data-kind="done" className={LINE}>
      {t(item.interrupted ? 'interrupted' : 'done')} · {item.secs}s{time}
      {item.error ? <span className="whitespace-pre-wrap text-destructive"> · {item.error}</span> : null}
    </div>
  );
}

export function NoticeLine({ text }: { text: string }) {
  const t = useT();
  return (
    <div data-kind="notice" className={LINE}>
      {t('resumed', text)}
    </div>
  );
}
