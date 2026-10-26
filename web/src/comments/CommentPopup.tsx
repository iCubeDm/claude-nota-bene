import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'react-redux';
import { isMediaAnchor, type Anchor, type QuickLabelId } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { selectSwitching } from '@/controls/slice.ts';
import { useAppDispatch, useAppSelector, type RootState } from '@/store/store.ts';
import { toast } from '@/shell/toast.ts';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { labelsFor, labelText } from './labels.ts';
import { LabelTip } from './LabelTip.tsx';
import { EmojiMenu } from './EmojiMenu.tsx';
import { MentionPicker } from '@/composer/MentionPicker.tsx';
import { ShortcodePicker } from './ShortcodePicker.tsx';
import { Attachments } from '@/attachments/Attachments.tsx';
import { hasFiles, useImageIntake } from '@/attachments/useImageIntake.ts';
import type { ImageEntry } from '@/composer/slice.ts';
import { mediaTime } from '@/media/markup/geometry.ts';
import { deleteMarks, type MediaAnchorPatch } from '@/media/markup/createMediaComment.ts';
import { addComment, setPanelOpen } from './slice.ts';

/**
 * What the popup comments on. A text selection: anchor + rect (+ the letter typed to open it). A media drawing adds
 * `id` (the comment id, which names its mark folder) and `prepare` (renders and uploads the frame and the layer, and
 * returns their attachment ids plus what only it knows for sure: the exact time, the version, the scale; on failure it
 * has already removed the folder).
 */
export type PendingComment = {
  anchor: Anchor; rect: DOMRect; text?: string;
  id?: string; prepare?: () => Promise<{ images: string[]; anchor?: MediaAnchorPatch }>;
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The popup's header line: the quoted text, or the media file (with the time) and its shape count. */
function quoteOf(a: Anchor, t: ReturnType<typeof useT>): string {
  return isMediaAnchor(a)
    ? `${baseName(a.source.path)}${a.time !== undefined ? ` @ ${mediaTime(a.time)}` : ''} · ${t('markShapes', a.shapes.length)}`
    : `«${a.quote.trim()}»`;
}

/**
 * The popup next to a fresh selection or drawing: a note plus optional quick-label chips; a chip adds at once.
 * `onAdded`: after the comment is in the store (a drawing clears its draft then, never before).
 * `onBusy`: a drawing's Add started (true) or ended without a comment (false); the parent keeps the popup meanwhile.
 * `hidden`: its tab is not shown (kept only while busy or after a failed save): no keys, no outside clicks.
 *
 * Once Add has started saving a drawing, nothing but a session switch cancels it: Esc and outside clicks are ignored,
 * and an unmount (the tab closed) does not stop it; the comment is added when the files are written. A failure the
 * user cannot see (unmounted or hidden) is a toast that carries the typed text, so it is never lost silently.
 */
export function CommentPopup({ pending, onClose, onAdded, onBusy, hidden = false }: {
  pending: PendingComment; onClose: () => void; onAdded?: () => void; onBusy?: (busy: boolean) => void; hidden?: boolean;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  // the comment set belongs to the session being left: no new comment mid-switch (the server resets it with the session)
  const switching = useAppSelector(selectSwitching);
  // read from the store at decision time: after an unmount there are no renders to refresh a ref
  const store = useStore<RootState>();
  const protocol = useAppSelector((s) => s.controls.protocol);
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(pending.text ?? '');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [note, setNote] = useState('');
  const [dropping, setDropping] = useState(false);
  const [busy, setBusyState] = useState(false); // a drawing's files are being written
  const busyNow = useRef(false); // a second click in the same tick must not start a second prepare
  const setBusy = (v: boolean) => {
    busyNow.current = v;
    if (alive.current) setBusyState(v);
    onBusy?.(v);
  };
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;
  // false once unmounted: what the save says then goes to a toast
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const fileIn = useRef<HTMLInputElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = (m: string, ms = 3000) => {
    setNote(m);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), ms);
  };
  const intake = useImageIntake({
    onUploaded: (im) => setImages((l) => (l.some((x) => x.id === im.id) ? l : [...l, im])),
    notify,
  });
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const uploading = intake.pending.length > 0;

  const add = async (label?: QuickLabelId) => {
    if (uploading || switching || busyNow.current) return;
    const body = text.trim();
    const { prepare, id } = pending;
    // a drawing is content of its own: no text and no label is still a comment
    const has = !!(prepare || body || label || images.length);
    let prepared: string[] = [];
    let anchor = pending.anchor;
    if (prepare) {
      setBusy(true);
      try {
        const r = await prepare();
        prepared = r.images;
        if (r.anchor && isMediaAnchor(anchor)) anchor = { ...anchor, ...r.anchor };
      } catch (e) {
        // prepare removed the folder; the popup and the drawing stay, so Add can be tried again
        const msg = t('markSaveFailed', e instanceof Error ? e.message : String(e));
        setBusy(false);
        if (alive.current) notify(msg, 8000);
        if (!alive.current || hiddenNow.current) toast(msg, body || quoteOf(pending.anchor, t));
        return;
      }
      // a session switch began meanwhile: the comment set belongs to the session left, the comment never came to be
      if (selectSwitching(store.getState())) {
        if (id) await deleteMarks(id); // done before Add is offered again, so a retry cannot race the delete
        setBusy(false);
        return;
      }
    }
    if (prepare) setBusy(false); // the save is over (the parent stops holding the popup)
    const all = [...prepared, ...images.map((i) => i.id)];
    if (has) dispatch(addComment({ ...(id && { id }), anchor, text: body, ...(label && { label }), ...(all.length && { images: all }) }));
    // the user has moved on (the tab closed or in the background): their selection and the panel are not ours to touch
    const seen = alive.current && !hiddenNow.current;
    if (seen) window.getSelection()?.removeAllRanges();
    if (has) onAdded?.();
    onClose();
    if (has && seen) dispatch(setPanelOpen(true));
  };
  const off = uploading || switching || busy;

  // focus once positioned: a `visibility:hidden` textarea (before the layout effect sets pos) cannot take focus
  const placed = pos !== null;
  useEffect(() => {
    if (!placed || !area.current) return;
    area.current.focus({ preventScroll: true });
    const end = area.current.value.length; // opened by typing: the caret goes after what was typed
    area.current.setSelectionRange(end, end);
  }, [placed]);

  useEffect(() => {
    // capture + preventDefault: this Esc must not also interrupt the agent (Composer skips defaultPrevented)
    if (hidden) return;
    // while a drawing is being saved, neither cancels: the save finishes and adds the comment
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (!busyNow.current) onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (busyNow.current) return;
      // the lightbox is portalled out of the popup: a click there is not an outside click
      if (!root.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-lightbox]')) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, hidden]);

  useLayoutEffect(() => {
    if (!root.current) return;
    const { offsetWidth: w, offsetHeight: h } = root.current;
    const { rect } = pending;
    const below = rect.bottom + 6 + h <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)),
      top: Math.max(8, below ? rect.bottom + 6 : rect.top - h - 6),
    });
  }, [pending]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation(); // never reaches the composer
    void add();
  };
  const quote = quoteOf(pending.anchor, t);

  return (
    <div
      ref={root}
      role="dialog"
      className="fixed z-10 w-[340px] rounded-[10px] border border-border bg-popover p-2 data-[dropping]:outline-2 data-[dropping]:outline-dashed data-[dropping]:outline-primary shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
      data-dropping={dropping || undefined}
      onDragOver={(e) => {
        if (!hasFiles(e.nativeEvent)) return;
        e.preventDefault();
        e.stopPropagation(); // not the composer's window-wide drop
        setDropping(true);
      }}
      onDragLeave={(e) => { if (!root.current?.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => {
        if (!hasFiles(e.nativeEvent)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropping(false);
        intake.add(e.dataTransfer.files);
      }}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="mb-1.5 truncate border-l-2 border-nb-accent pl-1.5 text-[11px] text-muted-foreground">{quote}</div>
      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={intake.onPaste}
        readOnly={busy}
        placeholder={t('commentPh')}
        aria-label={t('commentPh')}
        className="min-h-16 w-full resize-y rounded-md border border-border-soft bg-background px-2 py-1.5 text-[13px] leading-[1.45] text-foreground focus:border-primary focus:outline-none"
      />
      <Attachments
        data-testid="popup-thumbs"
        ids={images.map((i) => i.id)}
        pending={intake.pending}
        onRemove={(id) => setImages((l) => l.filter((x) => x.id !== id))}
      />
      {note && <div className="mt-1 text-[11px] text-warn">{note}</div>}
      <ShortcodePicker target={area} />
      <MentionPicker target={area} />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {labelsFor(protocol).map((l) => (
          <Tooltip key={l.id}>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button
                  type="button"
                  aria-label={labelText(l.id)}
                  disabled={off}
                  onClick={() => void add(l.id)}
                  className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-full border border-border-soft px-1.5 text-sm leading-none hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  {l.emoji}
                </button>
              </span>
            </TooltipTrigger>
            <LabelTip id={l.id} note={switching ? t('switching') : undefined} />
          </Tooltip>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
        <span>{t('popHint')}</span>
        <span className="flex items-center gap-1">
          <input
            ref={fileIn}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="popup-file-input"
            onChange={(e) => {
              intake.add(e.target.files ?? []);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            title={t('attachHere')}
            aria-label={t('attachHere')}
            onClick={() => fileIn.current?.click()}
            className="rounded px-1 text-sm hover:bg-muted"
          >
            📎
          </button>
          <span data-slot="emoji"><EmojiMenu target={area} /></span>
          <Button size="xs" disabled={off} aria-busy={busy || undefined} title={switching ? t('switching') : undefined} onClick={() => void add()}>
            {busy && <span aria-hidden className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            {t('add')}
          </Button>
        </span>
      </div>
    </div>
  );
}
