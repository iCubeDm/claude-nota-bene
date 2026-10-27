import { isMediaAnchor } from '@nota-bene/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Attachments } from '@/attachments/Attachments.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { selectSwitching } from '@/controls/slice.ts';
import { Markdown } from '@/feed/Markdown.tsx';
import { useT } from '@/i18n/index.ts';
import { mediaTime } from '@/media/markup/geometry.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { CardActions } from './CardActions.tsx';
import { useCommentSource } from './useCommentSource.ts';
import { labelText, QUICK_LABELS } from '../labels.ts';
import { LabelTip } from '../LabelTip.tsx';
import { editComment, removeComment, selectComments } from '../slice.ts';

/**
 * One comment: number, where, quote (click = jump to source), text with inline edit, label chip.
 * Used in the side panel and in the popover over a mark (`popover`: the quote does not jump).
 */
export function CommentCard({ id, index, popover = false }: { id: string; index: number; popover?: boolean }) {
  const t = useT();
  const dispatch = useAppDispatch();
  // the comment set belongs to the session being left: edit and delete wait for the new one
  const switching = useAppSelector(selectSwitching);
  const c = useAppSelector(selectComments).find((x) => x.id === id);
  const { where, orphan, version, jump } = useCommentSource(c);
  const [editing, setEditing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const live = useRef(false); // true while an edit is open; guards double finish (✓ then blur)

  useEffect(() => {
    if (!editing || !body.current) return;
    const el = body.current;
    el.focus();
    const sel = window.getSelection();
    sel?.selectAllChildren(el);
    sel?.collapseToEnd();
  }, [editing]);

  if (!c) return null;
  const sent = c.status === 'sent';
  const media = isMediaAnchor(c.anchor) ? c.anchor : null;
  const changed = !!media?.version && version !== undefined && version !== media.version;
  // a media comment's images: [0] the frame with the shapes (the thumbnail), [1] the transparent layer (for the agent);
  // only pasted images after them go to the strip
  const strip = media ? c.images?.slice(2) : c.images;
  const label = c.label && QUICK_LABELS.find((l) => l.id === c.label);

  const finish = (save: boolean) => {
    if (!live.current) return;
    live.current = false;
    const next = (body.current?.textContent ?? '').trim();
    setEditing(false); // remounts the body (key), which also restores the stored text on revert
    if (save && next && next !== c.text) dispatch(editComment(c.id, next));
  };
  const start = () => {
    live.current = true;
    setEditing(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      // handled here: neither the popover nor the composer's interrupt may see this Esc
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  return (
    <div
      data-comment-id={c.id}
      data-editing={editing || undefined}
      className={`rounded-[10px] border px-3 py-2.5 text-[13px] ${popover ? 'bg-popover' : 'bg-card/50'} ${editing ? 'border-primary' : 'border-border-soft hover:border-border'}`}
    >
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
        <span>
          {index + 1}{where ? ` · ${where}` : ''}{sent ? ` · ${t('sentTag')}` : ''}
        </span>
        {!sent && <CardActions editing={editing} switching={switching} start={start} finish={finish} remove={() => dispatch(removeComment(c.id))} />}
      </div>
      {media ? (
        <div
          data-media-thumb
          onClick={popover ? undefined : jump}
          className={`flex items-end gap-2 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${popover ? '' : 'cursor-pointer'}`}
        >
          {c.images?.[0] && <img src={`/attach/${c.images[0]}`} alt="" loading="lazy" draggable={false} className="max-h-24 max-w-[60%] flex-none rounded border border-border-soft object-contain" />}
          <span className="min-w-0 truncate font-mono text-[11px]">
            {media.source.path.slice(media.source.path.lastIndexOf('/') + 1)}{media.time !== undefined ? ` @ ${mediaTime(media.time)}` : ''}
          </span>
        </div>
      ) : (
        <div
          onClick={popover ? undefined : jump}
          className={`line-clamp-3 border-l-2 border-nb-accent pl-2 text-xs text-muted-foreground ${popover ? '' : 'cursor-pointer'}`}
        >
          {isMediaAnchor(c.anchor) ? null : c.anchor.quote}
        </div>
      )}
      {orphan && <div className="mt-1 text-[11px] text-destructive">({t('orphaned')})</div>}
      {changed && <div className="mt-1 text-[11px] text-warn">{t('fileChanged')}</div>}
      <div
        key={String(editing)}
        ref={body}
        contentEditable={editing ? 'plaintext-only' : undefined}
        suppressContentEditableWarning
        onKeyDown={editing ? onKeyDown : undefined}
        onBlur={editing ? () => finish(true) : undefined}
        className={`-ml-1 mt-1.5 rounded px-1 py-0.5 outline-none focus:bg-muted ${editing ? 'whitespace-pre-wrap' : 'md-tight'}`}
      >
        {/* editing shows the raw markdown source as plain text; otherwise it is rendered (not final: no refs, no mermaid) */}
        {editing ? c.text : <Markdown text={c.text} final={false} breaks noHtml />}
      </div>
      {strip?.length ? <Attachments ids={strip} /> : null}
      {label && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              tabIndex={0}
              aria-label={labelText(label.id)}
              className="mt-1.5 inline-flex min-h-7 min-w-7 cursor-default items-center justify-center rounded-full border border-border-soft px-1.5 text-sm leading-none"
            >
              {label.emoji}
            </span>
          </TooltipTrigger>
          <LabelTip id={label.id} />
        </Tooltip>
      )}
    </div>
  );
}
