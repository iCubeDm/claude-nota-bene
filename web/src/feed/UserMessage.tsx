import { getLang, useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';

export const timeOf = (ts: number): string =>
  new Date(ts).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });

export function UserMessage({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  const t = useT();
  // replayed transcript events carry ts 0: historic bubbles show no time
  const time = item.ts === 0 ? '' : ' · ' + timeOf(item.ts);
  const mode = item.force ? t('youForced') : item.duringWork ? t('youBusy') : '';
  return (
    <div
      data-kind="user"
      data-item-id={item.id}
      className="my-2.5 whitespace-pre-wrap rounded-[10px] border border-border-soft bg-muted/55 px-3 py-2"
    >
      <div data-anchor-skip className="mb-0.5 font-mono text-[10.5px] text-muted-foreground">
        {t('you')}
        {time}
        {mode}
      </div>
      {item.text}
    </div>
  );
}
