import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { sendBatch } from '@/comments/send.ts';
import { selectPending } from '@/comments/slice.ts';
import { MentionPicker } from './MentionPicker.tsx';
import { selectDraft, setDraft } from './slice.ts';
import { interrupt, selectBusy, selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';

export function Composer() {
  const t = useT();
  const dispatch = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const conn = useAppSelector(selectConn);
  const nPending = useAppSelector(selectPending).length;
  const text = useAppSelector(selectDraft);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // autosize; max-height (40vh) is applied by CSS
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // empty: stay one line — a long placeholder would otherwise wrap and grow the field (prototype clips it)
    if (text) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // a send that failed while offline is forgotten once the socket is back, so a later drop shows no stale label
  useEffect(() => {
    if (conn === 'open') setFailed(false);
  }, [conn]);

  // Esc interrupts while busy, unless something else already handled it
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) dispatch(interrupt());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, dispatch]);

  const submit = (force: boolean) => {
    const r = dispatch(sendBatch(force));
    if (r === 'empty') return;
    setFailed(r === 'offline');
    if (r === 'sent') ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const force = e.metaKey || e.ctrlKey;
    if (e.shiftKey && !force) return;
    e.preventDefault();
    submit(force);
  };

  return (
    <div>
      <div className="flex min-h-0 items-center gap-2.5 pt-2 text-xs text-muted-foreground">
        {busy && (
          <>
            <span className="animate-pulse text-accent">●</span>
            {t('working')}
          </>
        )}
        {failed && conn !== 'open' && <span className="text-warn">{t('offline')}</span>}
      </div>
      <div className="flex items-end gap-2 pt-2.5 pb-1.5">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={t('composerPh')}
          onChange={(e) => {
            dispatch(setDraft(e.target.value));
            setFailed(false);
          }}
          onKeyDown={onKeyDown}
          className="max-h-[40vh] min-h-10 flex-1 resize-none rounded-[10px] border border-border-soft bg-[oklch(0.15_0.02_260/0.7)] px-3 py-[9px] text-foreground transition-[border-color,box-shadow] outline-none focus:border-[oklch(0.75_0.18_280/0.6)] focus:shadow-[0_0_0_3px_oklch(0.75_0.18_280/0.12)]"
        />
        <MentionPicker target={ref} />
        <Button type="button" className="h-10" onClick={() => submit(false)}>
          {nPending ? t('sendN', nPending) : t('send')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              disabled={!busy}
              aria-label={t('stopTip')}
              onClick={() => dispatch(interrupt())}
              className="h-10 bg-muted px-2.5 enabled:bg-destructive/15 enabled:text-destructive enabled:hover:bg-destructive/25 disabled:opacity-35"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{t('stopTip')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-h-[30px] items-center gap-2 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('keysTip')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
                <path d="M12 17h.01" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{t('keysTip')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
