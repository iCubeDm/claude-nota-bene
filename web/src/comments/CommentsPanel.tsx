import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { selectUploading } from '@/composer/slice.ts';
import { CommentCard } from './CommentCard.tsx';
import { selectCommentsUi, selectPending, setPanelOpen } from './slice.ts';

/** Overlay sheet on the right: slides over the chat, never resizes it. Positioned by a `relative` wrapper around <main>. */
export function CommentsPanel({ onSend }: { onSend: () => void }) {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectCommentsUi).panelOpen;
  const pending = useAppSelector(selectPending);
  const n = pending.length;
  const uploading = useAppSelector(selectUploading) > 0;
  const aside = useRef<HTMLElement>(null);
  // a closing panel becomes invisible: do not leave focus inside it, hand it back to the header toggle
  useEffect(() => {
    if (!open && aside.current?.contains(document.activeElement)) document.getElementById('toggleComments')?.focus();
  }, [open]);
  return (
    <aside
      ref={aside}
      id="comments"
      data-open={open}
      aria-hidden={!open}
      className={`absolute inset-y-0 right-0 z-[5] flex min-h-0 w-80 flex-col border-l border-border bg-side transition-[transform,visibility] duration-[180ms] ease-out ${open ? 'translate-x-0 shadow-[0_0_40px_rgba(0,0,0,0.35)]' : 'invisible translate-x-full'}`}
    >
      <div className="flex h-[41px] flex-none items-center justify-between border-b border-border-soft pr-2 pl-3.5 text-[13px] font-medium">
        <span id="cTitle">{n ? t('commentsN', n) : t('comments')}</span>
        <button
          type="button"
          id="cClose"
          title={t('hidePanel')}
          aria-label={t('hidePanel')}
          onClick={() => d(setPanelOpen(false))}
          className="grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ×
        </button>
      </div>
      <div id="cards" className="flex flex-1 flex-col gap-2 overflow-auto p-2">
        {n === 0 ? (
          <div className="whitespace-pre-line px-3 py-8 text-center text-xs leading-normal text-muted-foreground">{t('emptyComments')}</div>
        ) : (
          pending.map((c, i) => <CommentCard key={c.id} id={c.id} index={i} />)
        )}
      </div>
      <div className="flex-none border-t border-border-soft p-2">
        <span className="block" title={uploading ? t('uploadWait') : undefined}>
          <Button type="button" id="cSend" className="h-[34px] w-full" disabled={n === 0 || uploading} onClick={onSend}>
            {n ? t('sendN', n) : t('send')}
          </Button>
        </span>
      </div>
    </aside>
  );
}
