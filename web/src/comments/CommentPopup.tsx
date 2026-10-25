import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { QuickLabelId } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch } from '@/store/store.ts';
import { instructionOf, labelText, QUICK_LABELS } from './labels.ts';
import { EmojiMenu } from './EmojiMenu.tsx';
import type { PendingSelection } from './SelectionButton.tsx';
import { MentionPicker } from '@/composer/MentionPicker.tsx';
import { ShortcodePicker } from './ShortcodePicker.tsx';
import { addComment, setPanelOpen } from './slice.ts';

/** The popup next to a fresh selection: a note plus optional quick-label chips; a chip adds at once. */
export function CommentPopup({ pending, onClose }: { pending: PendingSelection; onClose: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const add = (label?: QuickLabelId) => {
    const body = text.trim();
    if (body || label) dispatch(addComment({ anchor: pending.anchor, text: body, ...(label && { label }) }));
    window.getSelection()?.removeAllRanges();
    onClose();
    if (body || label) dispatch(setPanelOpen(true));
  };

  useEffect(() => {
    area.current?.focus();
    // capture + preventDefault: this Esc must not also interrupt the agent (Composer skips defaultPrevented)
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
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
      className="fixed z-10 w-[340px] rounded-[10px] border border-border bg-popover p-2 shadow-[0_10px_32px_rgba(0,0,0,0.5)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="mb-1.5 truncate border-l-2 border-accent pl-1.5 text-[11px] text-muted-foreground">«{pending.anchor.quote.trim()}»</div>
      <textarea
        ref={area}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('commentPh')}
        aria-label={t('commentPh')}
        className="min-h-16 w-full resize-y rounded-md border border-border-soft bg-background px-2 py-1.5 text-[13px] leading-[1.45] text-foreground focus:border-primary focus:outline-none"
      />
      <ShortcodePicker target={area} />
      <MentionPicker target={area} />
      <div className="mt-1.5 flex flex-wrap gap-1">
        {QUICK_LABELS.map((l) => (
          <button
            key={l.id}
            type="button"
            title={instructionOf({ label: l.id })}
            onClick={() => add(l.id)}
            className="rounded-full border border-border-soft px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-accent hover:text-accent-foreground"
          >
            {l.emoji} {labelText(l.id)}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
        <span>{t('popHint')}</span>
        <span className="flex items-center gap-1">
          <span data-slot="emoji"><EmojiMenu target={area} /></span>
          <Button size="xs" onClick={() => add()}>{t('add')}</Button>
        </span>
      </div>
    </div>
  );
}
