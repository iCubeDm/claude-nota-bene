import { isMediaAnchor, type Comment } from '@nota-bene/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { scrollRangeIntoView } from '@/anchors/scroll.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { Attachments } from '@/attachments/Attachments.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { selectSwitching } from '@/controls/slice.ts';
import { Markdown } from '@/feed/Markdown.tsx';
import { jumpToFileComment, selectFileLoad, selectFileVersion } from '@/files/slice.ts';
import { useT } from '@/i18n/index.ts';
import { mediaTime } from '@/media/markup/geometry.ts';
import { activate } from '@/tabs/slice.ts';
import { selectReplyLabel, useAppDispatch, useAppSelector, type RootState } from '@/store/store.ts';
import { labelText, QUICK_LABELS } from './labels.ts';
import { LabelTip } from './LabelTip.tsx';
import { whereOfFile } from './send.ts';
import { closeCommentCard, editComment, removeComment, selectComments, selectPending, selectSentFor } from './slice.ts';

const BTN = 'inline-flex items-center px-0.5 text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground [&_svg]:size-[13px]';
const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'aria-hidden': true } as const;

const itemRoot = (id: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('[data-item-id]')].find((e) => e.dataset.itemId === id) ?? null;
/** The file tab's own text root: its pane element, carrying `data-file-path` (and `data-file-ref` for another source)
 * while it shows text. A `data-file-path` inside rendered markdown is file content, never a root. */
const fileRoot = (path: string, ref?: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('[data-pane]')].find((e) => e.dataset.filePath === path && (e.dataset.fileRef ?? '') === (ref ?? '')) ?? null;

/** `noTitle`: the button already sits in a Radix Tooltip, so a native title would show a second one. */
function IconButton({ label, className = '', noTitle = false, children, ...rest }: { label: string; className?: string; noTitle?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" title={noTitle ? undefined : label} aria-label={label} className={`${BTN} ${className} disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted-foreground`} {...rest}>
      {children}
    </button>
  );
}

/** The source item as the card needs it: missing (null), still streaming, or its text. undefined = not a message source. */
function sourceState(s: RootState, src: Comment['anchor']['source'] | undefined): null | 'streaming' | string | undefined {
  if (src?.kind !== 'message') return undefined;
  if (src.id.startsWith('plan:')) {
    const p = s.feed.items.find((x) => x.kind === 'permission' && `plan:${x.id}` === src.id);
    return p?.kind === 'permission' ? String(p.input.plan ?? '') : null;
  }
  const it = s.feed.items.find((x) => (x.kind === 'assistant' || x.kind === 'user') && x.id === src.id);
  if (!it || (it.kind !== 'assistant' && it.kind !== 'user')) return null;
  return it.kind === 'assistant' && !it.final ? 'streaming' : it.text;
}

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
  // a string compared by value: the card re-renders when its source item's text changes, not on every feed delta
  const srcState = useAppSelector((s) => sourceState(s, c?.anchor.source));
  const where = useAppSelector((s) => {
    const src = c?.anchor.source;
    return src?.kind === 'message' ? selectReplyLabel(s, src.id) : src ? whereOfFile(src) : null;
  });
  // a file source: its open view's load state; undefined (tab closed / not loaded yet) means "unknown", not orphaned
  const fileLoad = useAppSelector((s) => (c?.anchor.source.kind === 'file' ? selectFileLoad(s, c.anchor.source.path, c.anchor.source.ref) : undefined));
  // a media comment: the file's current version, known while its tab is open (undefined = unknown, no claim)
  const version = useAppSelector((s) => (c && isMediaAnchor(c.anchor) ? selectFileVersion(s, c.anchor.source.path, c.anchor.source.ref) : undefined));
  const [editing, setEditing] = useState(false);
  const [orphan, setOrphan] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const live = useRef(false); // true while an edit is open; guards double finish (✓ then blur)

  // a source missing from the feed is an orphan (also an interrupted `stream:N` reply after a restart); for a
  // settled item the DOM is the truth: only a rendered item whose text no longer matches counts
  // a file: orphaned only once its view has settled, gone (deleted, binary, too large) or with text the quote is not in
  useEffect(() => {
    const src = c?.anchor.source;
    if (!c || src?.kind !== 'file') return;
    if (isMediaAnchor(c.anchor)) return setOrphan(false); // a media mark is drawn from relative coordinates: never orphaned
    if (!fileLoad || fileLoad.s === 'loading') return setOrphan(false);
    if (fileLoad.s === 'gone') return setOrphan(true);
    const root = fileRoot(src.path, src.ref);
    setOrphan(!!root && !rangeForAnchor(root, c.anchor));
  }, [c, fileLoad]);
  useEffect(() => {
    const src = c?.anchor.source;
    if (src?.kind === 'file') return;
    if (!c || src?.kind !== 'message' || srcState === undefined || srcState === 'streaming') return setOrphan(false);
    if (srcState === null) return setOrphan(true);
    const root = itemRoot(src.id);
    setOrphan(!!root && !rangeForAnchor(root, c.anchor));
  }, [c, srcState]);

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
  const noFocusSteal = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };
  const jump = () => {
    const src = c.anchor.source;
    // a file: open (or activate) its tab; the view scrolls once its text is loaded (files.jump)
    if (src.kind === 'file') return void dispatch(jumpToFileComment(src.path, c.id, src.ref));
    const root = itemRoot(src.id);
    if (!root) return;
    flushSync(() => dispatch(activate('chat'))); // a hidden chat pane cannot scroll: show it before measuring
    const range = rangeForAnchor(root, c.anchor);
    const scroller = root.closest<HTMLElement>('[data-chat-pane]');
    if (range && scroller) scrollRangeIntoView(range, scroller); // the fragment itself, not the whole message
    else root.scrollIntoView({ behavior: 'smooth', block: 'center' }); // orphan: the message
    root.classList.remove('nb-flash');
    void root.offsetWidth; // restart the animation
    root.classList.add('nb-flash');
    setTimeout(() => root.classList.remove('nb-flash'), 1300);
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
        {!sent && (
          <span className="flex items-center gap-0.5">
            {editing ? (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <IconButton label={t('editTip')} noTitle {...noFocusSteal}>
                      <svg {...svg} strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" /><path d="M12 17h.01" /></svg>
                    </IconButton>
                  </TooltipTrigger>
                  <TooltipContent className="whitespace-pre-line">{t('editTip')}</TooltipContent>
                </Tooltip>
                <IconButton label={t('save')} className="hover:text-success" {...noFocusSteal} onClick={() => finish(true)}>
                  <svg {...svg} strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
                </IconButton>
                <IconButton label={t('cancel')} {...noFocusSteal} onClick={() => finish(false)}>
                  <svg {...svg} strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </IconButton>
              </>
            ) : (
              <>
                <IconButton label={t('edit')} disabled={switching} title={switching ? t('switching') : undefined} onClick={start}>
                  <svg {...svg} strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </IconButton>
                <IconButton label={t('del')} className="hover:text-destructive" disabled={switching} title={switching ? t('switching') : undefined} onClick={() => dispatch(removeComment(c.id))}>
                  <svg {...svg} strokeWidth="2"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
                </IconButton>
              </>
            )}
          </span>
        )}
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

/** The card over a mark (from `ui.card`): kept in the viewport; closes on outside mousedown, Esc, or when its comment is gone. */
export function CommentCardPopover() {
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.comments.ui.card);
  const items = useAppSelector(selectComments);
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // `gone` is over all items: an in-flight id is not in selectPending but must not close the popover
  const c = card ? items.find((x) => x.id === card.id) : undefined;
  const gone = !!card && !c;
  // the number the comment has where it is listed: the panel (pending) or its batch in the sent bubble
  const index = useAppSelector((s) => {
    if (!c) return -1;
    if (c.status === 'sent') return c.sentIn === undefined ? -1 : selectSentFor(s, c.sentIn).findIndex((x) => x.id === c.id);
    const i = selectPending(s).findIndex((x) => x.id === c.id);
    return i >= 0 ? i : items.filter((x) => x.status === 'pending').findIndex((x) => x.id === c.id); // in flight
  });

  useEffect(() => {
    if (gone) dispatch(closeCommentCard());
  }, [gone, dispatch]);

  useEffect(() => {
    if (!card) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Esc inside the edit box belongs to the card (revert only); a second Esc closes
      if ((e.target as HTMLElement | null)?.closest?.('[contenteditable]')) return;
      e.preventDefault(); // so the composer does not read it as an interrupt
      dispatch(closeCommentCard());
    };
    const onDown = (e: MouseEvent) => {
      if (root.current?.contains(e.target as Node) || (e.target as Element).closest?.('[data-lightbox]')) return; // the lightbox is portalled out
      const a = document.activeElement as HTMLElement | null;
      if (a && root.current?.contains(a)) a.blur(); // "click outside = save" before the card unmounts
      dispatch(closeCommentCard());
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [card, dispatch]);

  const place = useCallback(() => {
    if (!card || !root.current) return;
    const { offsetWidth: w, offsetHeight: h } = root.current;
    const below = card.y + 6 + h <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(card.x, window.innerWidth - w - 8)),
      top: Math.max(8, below ? card.y + 6 : card.y - h - 6),
    });
  }, [card]);
  useLayoutEffect(place, [place, items]);
  // the card grows while its text is edited: keep it inside the viewport
  const shown = !!card && !!c;
  useEffect(() => {
    if (!shown || !root.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [shown, place]);

  if (!card || !c) return null;
  return (
    <div
      ref={root}
      role="dialog"
      className="fixed z-10 w-[340px] shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <CommentCard id={card.id} index={Math.max(0, index)} popover />
    </div>
  );
}
