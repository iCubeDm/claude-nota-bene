import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { answerPermission, useAppDispatch } from '@/store/store.ts';

export function PermissionCard({ item }: { item: Extract<FeedItem, { kind: 'permission' }> }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const [values, setValues] = useState<Record<string, string>>({});
  const prompt = item.prompt;
  useEffect(() => { if (item.answer !== undefined) setValues({}); }, [item.answer]);
  const choiceLabel = (label: string) => ({ accept: t('allow'), decline: t('deny'), cancel: t('cancel'), acceptForSession: t('allowSession'), 'Allow for this turn': t('allowTurn'), 'Allow for this session': t('allowSession'), 'Deny': t('deny'), 'Cancel': t('cancel'), 'Accept': t('allow'), 'Decline': t('deny'), 'Send answers': t('sendAnswers') })[label] ?? label;
  const title = prompt?.title === 'Additional Codex permissions' ? t('codexPermissions') : prompt?.title === 'MCP request' ? t('nativeMcpRequest') : prompt?.title;
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
      <b>{title ?? t('allowQ', item.toolName)}</b>
      <pre className="my-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-xs">{body}</pre>
      {resolved ? (
        <span>{t(item.answer ? prompt?.fields ? 'answerSent' : 'allowed' : 'denied')}</span>
      ) : item.archived ? (
        <span data-archived>{t('askArchived')}</span>
      ) : prompt ? (
        <form onSubmit={(e) => e.preventDefault()} className="space-y-2">
          {prompt.url && <a href={prompt.url} target="_blank" rel="noreferrer" className="underline">{prompt.url}</a>}
          {(prompt.fields ?? []).map((f) => <label key={f.id} className="block whitespace-pre-wrap">
            {f.label}
            {f.options?.length ? <span className="block text-xs text-muted-foreground">{f.options.join(' · ')}</span> : null}
            <input aria-label={f.label} type={f.secret ? 'password' : 'text'} autoComplete="off" value={values[f.id] ?? ''} list={f.options?.length ? `options-${item.id}-${f.id}` : undefined} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} className="mt-1 block w-full rounded border border-border-soft bg-transparent p-2" />
            {f.options?.length ? <datalist id={`options-${item.id}-${f.id}`}>{f.options.map((v) => <option key={v} value={v} />)}</datalist> : null}
          </label>)}
          <div className="flex flex-wrap gap-2">{prompt.choices.map((c) => <button key={c.id} type="button" className={`${btn} bg-muted`} disabled={!['cancel', 'decline', 'deny'].includes(c.id) && prompt.fields?.some((f) => f.required && !values[f.id]?.trim())} onClick={() => dispatch(answerPermission(item.id, true, { choice: c.id, ...(prompt.fields ? { values } : {}) }))}>{choiceLabel(c.label)}</button>)}</div>
        </form>
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
