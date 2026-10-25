import { Attachments } from '@/attachments/Attachments.tsx';
import { getLang, useT } from '@/i18n/index.ts';
import { en } from '@/i18n/en.ts';
import { ru } from '@/i18n/ru.ts';
import { splitMentionsRaw } from '@/refs/refs.ts';
import { labelOf } from '@/comments/labels.ts';
import { selectSentFor } from '@/comments/slice.ts';
import type { FeedItem } from '@/store/feed.ts';
import { useAppSelector } from '@/store/store.ts';

export const timeOf = (ts: number): string =>
  new Date(ts).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// both headers, so a batch sent in one language still folds up after switching (prototype BATCH_RE)
const BATCH_RE = new RegExp(`(?:^|\\n\\n)(?:${esc(ru.batchHead)}|${esc(en.batchHead)})\\n\\n`);

export function UserMessage({ item }: { item: Extract<FeedItem, { kind: 'user' }> }) {
  const t = useT();
  const sent = useAppSelector((s) => selectSentFor(s, item.id));
  // replayed transcript events carry ts 0: historic bubbles show no time
  const time = item.ts === 0 ? '' : ' · ' + timeOf(item.ts);
  const mode = item.force ? t('youForced') : item.duringWork ? t('youBusy') : '';
  const m = BATCH_RE.exec(item.text);
  const general = m ? item.text.slice(0, m.index) : item.text;
  const raw = m ? item.text.slice(m.index + m[0].length) : '';
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
      {splitMentionsRaw(general).map((p, i) =>
        'mention' in p ? (
          <span key={i} className="ref mention" data-path={p.mention}>{p.raw}</span>
        ) : (
          p.text
        ),
      )}
      {item.images && <Attachments ids={item.images.map((i) => i.id)} />}
      {(sent.length > 0 || raw) && (
        <details data-anchor-skip className="mt-1.5 text-[13px] text-muted-foreground">
          <summary className="cursor-pointer">{sent.length ? t('nComments', sent.length) : t('commentsLc')}</summary>
          {sent.length
            ? sent.map((c) => (
                <div key={c.id} className="mt-1.5">
                  <blockquote className="border-l-2 border-border pl-2">{c.anchor.quote}</blockquote>
                  <div>
                    →{' '}
                    {c.label && <span className="mr-1 rounded bg-muted px-1">{labelOf(c)}</span>}
                    {c.text}
                  </div>
                </div>
              ))
            : <div className="mt-1.5">{raw}</div>}
        </details>
      )}
    </div>
  );
}
