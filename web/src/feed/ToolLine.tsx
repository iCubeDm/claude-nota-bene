import type { FeedItem } from '@/store/feed.ts';

export function ToolLine({ item }: { item: Extract<FeedItem, { kind: 'tool' }> }) {
  return (
    <div
      data-kind="tool"
      className={
        'my-2.5 truncate font-mono text-[11.5px] leading-normal ' +
        (item.error ? 'text-destructive' : 'text-muted-foreground') +
        (item.sub ? ' pl-5 opacity-65' : '')
      }
    >
      ▸ {item.name}
      {item.arg ? ` · ${item.arg}` : ''}
    </div>
  );
}
