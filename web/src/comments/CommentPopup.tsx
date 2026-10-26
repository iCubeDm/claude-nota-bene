import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { QuickLabelId } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { selectSwitching } from '@/controls/slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { labelsFor, labelText } from './labels.ts';
import { LabelTip } from './LabelTip.tsx';
import { EmojiMenu } from './EmojiMenu.tsx';
import type { PendingSelection } from './SelectionButton.tsx';
import { MentionPicker } from '@/composer/MentionPicker.tsx';
import { ShortcodePicker } from './ShortcodePicker.tsx';
import { Attachments } from '@/attachments/Attachments.tsx';
import { hasFiles, useImageIntake } from '@/attachments/useImageIntake.ts';
import type { ImageEntry } from '@/composer/slice.ts';
import { addComment, setPanelOpen } from './slice.ts';

/** The popup next to a fresh selection: a note plus optional quick-label chips; a chip adds at once. */
export function CommentPopup({ pending, onClose }: { pending: PendingSelection; onClose: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  // the comment set belongs to the session being left: no new comment mid-switch (the server resets it with the session)
  const switching = useAppSelector(selectSwitching);
  const protocol = useAppSelector((s) => s.controls.protocol);
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(pending.text ?? '');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [note, setNote] = useState('');
  const [dropping, setDropping] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const intake = useImageIntake({
    onUploaded: (im) => setImages((l) => (l.some((x) => x.id === im.id) ? l : [...l, im])),
    notify: (m) => {
      setNote(m);
      clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => setNote(''), 3000);
    },
  });
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const uploading = intake.pending.length > 0;

  const add = (label?: QuickLabelId) => {
    if (uploading || switching) return;
    const body = text.trim();
    const has = !!(body || label || images.length);
    if (has) dispatch(addComment({ anchor: pending.anchor, text: body, ...(label && { label }), ...(images.length && { images: images.map((i) => i.id) }) }));
    window.getSelection()?.removeAllRanges();
    onClose();
    if (has) dispatch(setPanelOpen(true));
  };

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
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      // the lightbox is portalled out of the popup: a click there is not an outside click
      if (!root.current?.contains(e.target as Node) && !(e.target as Element).closest?.('[data-lightbox]')) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

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
    add();
  };

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
      <div className="mb-1.5 truncate border-l-2 border-nb-accent pl-1.5 text-[11px] text-muted-foreground">«{pending.anchor.quote.trim()}»</div>
      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={intake.onPaste}
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
                  disabled={uploading || switching}
                  onClick={() => add(l.id)}
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
          <Button size="xs" disabled={uploading || switching} title={switching ? t('switching') : undefined} onClick={() => add()}>{t('add')}</Button>
        </span>
      </div>
    </div>
  );
}
