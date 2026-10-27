import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { CommentCard } from '../CommentCard.tsx';
import { closeCommentCard, selectComments, selectPending, selectSentFor } from '../slice.ts';

/** Where the popover sits: next to the click, kept in the viewport, re-placed when the items change or the card grows. */
function usePopoverPlacement(root: RefObject<HTMLDivElement | null>, card: { x: number; y: number } | null | undefined, shown: boolean, items: unknown) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const place = useCallback(() => {
    if (!card || !root.current) return;
    const { offsetWidth: w, offsetHeight: h } = root.current;
    const below = card.y + 6 + h <= window.innerHeight;
    setPos({
      left: Math.max(8, Math.min(card.x, window.innerWidth - w - 8)),
      top: Math.max(8, below ? card.y + 6 : card.y - h - 6),
    });
  }, [card, root]);
  useLayoutEffect(place, [place, items]);
  // the card grows while its text is edited: keep it inside the viewport
  useEffect(() => {
    if (!shown || !root.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [shown, place, root]);
  return pos;
}

/** The card over a mark (from `ui.card`): kept in the viewport; closes on outside mousedown, Esc, or when its comment is gone. */
export function CommentCardPopover() {
  const dispatch = useAppDispatch();
  const card = useAppSelector((s) => s.comments.ui.card);
  const items = useAppSelector(selectComments);
  const root = useRef<HTMLDivElement>(null);
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

  const pos = usePopoverPlacement(root, card, !!card && !!c, items);

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
