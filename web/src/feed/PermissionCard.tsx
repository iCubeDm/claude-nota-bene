import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { answerPermission, useAppDispatch } from '@/store/store.ts';

export function PermissionCard({ item }: { item: Extract<FeedItem, { kind: 'permission' }> }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const resolved = item.answer !== undefined;
  const body = String(item.input.command ?? item.input.file_path ?? JSON.stringify(item.input, null, 2));
  const btn = 'rounded-lg border border-transparent px-3 py-1 text-[13px] font-medium';
  return (
    <div
      data-kind="permission"
      className={
        'my-2.5 rounded-[10px] border bg-card px-3 py-2 text-[13px] ' +
        (resolved || item.archived ? 'border-border-soft opacity-60' : 'border-warn')
      }
    >
      <b>{t('allowQ', item.toolName)}</b>
      <pre className="my-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-xs">{body}</pre>
      {resolved ? (
        <span>{t(item.answer ? 'allowed' : 'denied')}</span>
      ) : item.archived ? (
        <span data-archived>{t('askArchived')}</span>
      ) : (
        <>
          <button
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() => dispatch(answerPermission(item.id, true))}
          >
            {t('allow')}
          </button>{' '}
          <button
            className={`${btn} bg-muted text-muted-foreground hover:text-foreground`}
            onClick={() => dispatch(answerPermission(item.id, false))}
          >
            {t('deny')}
          </button>
        </>
      )}
    </div>
  );
}
