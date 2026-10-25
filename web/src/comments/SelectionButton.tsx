import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Anchor } from '@nota-bene/shared';
import { makeAnchor } from '@/anchors/resolve.ts';
import { offsetsOf, textOf } from '@/anchors/text.ts';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';

/** What the popup (M1-10) needs: where the text is anchored and where to put the popup. */
export type PendingSelection = { anchor: Anchor; rect: DOMRect };

const elementOf = (n: Node): Element | null => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);

/** The selection inside one commentable chat item (a user message or a FINAL assistant reply), clipped to that item. */
function readSelection(): PendingSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const start = elementOf(range.startContainer);
  if (!start?.closest('#items')) return null;
  const root = start.closest<HTMLElement>('[data-item-id]');
  const id = root?.dataset.itemId;
  if (!root || !id) return null;
  const kind = root.dataset.kind;
  if (!(kind === 'user' || (kind === 'assistant' && root.dataset.final === 'true'))) return null;

  const clipped = range.cloneRange();
  if (!root.contains(range.endContainer)) clipped.setEnd(root, root.childNodes.length);
  const o = offsetsOf(root, clipped);
  if (!o || o.start === o.end) return null;
  const text = textOf(root);
  if (!text.slice(o.start, o.end).trim()) return null;
  return { anchor: makeAnchor({ kind: 'message', id }, text, o.start, o.end), rect: clipped.getBoundingClientRect() };
}

type View = { left: number; right: number; top: number; bottom: number };

/** The visible chat pane; the window when the pane has no layout. */
function viewOf(): View {
  const r = document.querySelector('[data-chat-pane]')?.getBoundingClientRect();
  return r && r.height > 0 && r.width > 0 ? r : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** The edge the button attaches to (bottom, or top when there is no room below) must be inside the pane, horizontally overlapping. */
function attachedInside(rect: DOMRect, view: View): boolean {
  if (rect.right <= view.left || rect.left >= view.right) return false;
  const edge = rect.bottom + 6 + 32 <= view.bottom ? rect.bottom : rect.top;
  return edge >= view.top && edge <= view.bottom;
}

/** Floating "comment" button next to a text selection in the chat. */
export function SelectionButton({ onComment }: { onComment: (s: PendingSelection) => void }) {
  const t = useT();
  const [sel, setSel] = useState<PendingSelection | null>(null);
  const shown = useRef(false);
  const dismissed = useRef(false); // Esc / click: the DOM selection stays, so scroll must not bring the button back
  shown.current = sel !== null;
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (btn.current?.contains(e.target as Node)) return;
      dismissed.current = false;
      // the browser updates the selection after mouseup, so read it one tick later
      setTimeout(() => setSel(readSelection()));
    };
    const hide = () => setSel(null);
    // capture phase + preventDefault: Esc that dismisses the button must not also interrupt the agent (Composer skips defaultPrevented)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !shown.current) return;
      e.preventDefault();
      dismissed.current = true;
      hide();
    };
    const pane = document.querySelector<HTMLElement>('[data-chat-pane]');
    // scroll (also the feed's own autoscroll while streaming): follow the text, hide only when the selection is gone or scrolled out of view
    const onScroll = () => {
      if (dismissed.current) return;
      const next = readSelection();
      const view = viewOf();
      setSel(next && attachedInside(next.rect, view) ? next : null);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey, true);
    pane?.addEventListener('scroll', onScroll, { capture: true }); // capture: nested scrollers (pre, tables) do not bubble
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey, true);
      pane?.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (!sel || !btn.current) return setPos(null);
    const { offsetWidth: w, offsetHeight: h } = btn.current;
    const view = viewOf();
    const below = sel.rect.bottom + 6 + h <= view.bottom;
    const top = below ? sel.rect.bottom + 6 : sel.rect.top - h - 6;
    setPos({
      left: Math.max(view.left + 8, Math.min(sel.rect.left, view.right - w - 8)),
      top: Math.max(view.top + 4, Math.min(top, view.bottom - h - 4)), // never over the composer / outside the pane
    });
  }, [sel]);

  if (!sel) return null;
  return (
    <Button
      ref={btn}
      size="sm"
      className="fixed z-10 shadow-[0_6px_20px_rgba(0,0,0,0.4)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.preventDefault()} // keep the text selected through the click
      onClick={() => {
        dismissed.current = true;
        onComment(sel);
        setSel(null);
      }}
    >
      {t('commentBtn')}
    </Button>
  );
}
