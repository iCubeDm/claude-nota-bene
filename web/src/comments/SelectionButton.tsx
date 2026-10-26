import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Anchor, AnchorSource } from '@nota-bene/shared';
import { makeAnchor } from '@/anchors/resolve.ts';
import { offsetsOf, textOf } from '@/anchors/text.ts';
import type { QuickLabelId } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { selectSwitching } from '@/controls/slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { labelsFor, labelText } from './labels.ts';
import { LabelTip } from './LabelTip.tsx';
import { addComment, setPanelOpen } from './slice.ts';
import { editable } from '@/lib/editable.ts';

/** What the popup (M1-10) needs: where the text is anchored and where to put the popup; `text` is what was typed to open it. */
export type PendingSelection = { anchor: Anchor; rect: DOMRect; text?: string };

/** The labels offered right next to the selection, one click each; the rest are in the popup. */
const BAR: QuickLabelId[] = ['looks-good', 'fire', 'clarify', 'verify', 'out-of-scope'];


const elementOf = (n: Node): Element | null => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);

/** The visible pane (chat or file tab): only one is not `hidden`. Older layouts have only the chat pane. */
const activePane = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-pane]:not([hidden])') ?? document.querySelector<HTMLElement>('[data-chat-pane]');

/**
 * The commentable root the selection starts in, with its anchor source, only inside the ACTIVE pane: in the chat a
 * chat item (a user message or a FINAL assistant reply); in a file tab its text root, the OUTERMOST `data-file-path`
 * in the pane (FileView sets it on the pane while it shows text; one inside rendered markdown is file content).
 */
function rootOf(start: Element): { root: HTMLElement; source: AnchorSource } | null {
  const pane = activePane();
  if (!pane?.contains(start)) return null;
  if (pane.matches('[data-chat-pane]')) {
    if (!start.closest('#items')) return null;
    const root = start.closest<HTMLElement>('[data-item-id]');
    const id = root?.dataset.itemId;
    if (!root || !id || !pane.contains(root)) return null;
    if (id.startsWith('stream:')) return null; // an interrupted reply keeps its per-run id, unstable across restarts: a comment on it would orphan
    const kind = root.dataset.kind;
    if (!(kind === 'user' || kind === 'plan' || (kind === 'assistant' && root.dataset.final === 'true'))) return null;
    return { root, source: { kind: 'message', id } };
  }
  let root: HTMLElement | null = null;
  for (let e: HTMLElement | null = start.closest<HTMLElement>('[data-file-path]'); e && pane.contains(e); e = e.parentElement?.closest<HTMLElement>('[data-file-path]') ?? null) root = e;
  const path = root?.dataset.filePath;
  // another source's view carries its ref on the pane (M3-16): the comment names `path @ ref`
  const ref = pane.dataset.fileRef;
  return root && path ? { root, source: ref ? { kind: 'file', path, ref } : { kind: 'file', path } } : null;
}

/** The selection inside one commentable root, clipped to that root. */
function readSelection(): PendingSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const start = elementOf(range.startContainer);
  const hit = start && rootOf(start);
  if (!hit) return null;
  const { root, source } = hit;

  const clipped = range.cloneRange();
  if (!root.contains(range.endContainer)) clipped.setEnd(root, root.childNodes.length);
  const o = offsetsOf(root, clipped);
  if (!o || o.start === o.end) return null;
  const text = textOf(root);
  if (!text.slice(o.start, o.end).trim()) return null;
  return { anchor: makeAnchor(source, text, o.start, o.end), rect: clipped.getBoundingClientRect() };
}

type View = { left: number; right: number; top: number; bottom: number };

/** The visible pane's box; the window when the pane has no layout. */
function viewOf(): View {
  const r = activePane()?.getBoundingClientRect();
  return r && r.height > 0 && r.width > 0 ? r : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/** The edge the button attaches to (bottom, or top when there is no room below) must be inside the pane, horizontally overlapping. */
function attachedInside(rect: DOMRect, view: View): boolean {
  if (rect.right <= view.left || rect.left >= view.right) return false;
  const edge = rect.bottom + 6 + 32 <= view.bottom ? rect.bottom : rect.top;
  return edge >= view.top && edge <= view.bottom;
}

/**
 * Floating bar next to a text selection in the chat or an open file: "comment" opens the popup, a label chip adds a
 * labelled comment at once, and typing (or Enter) opens the popup with what was typed.
 */
export function SelectionButton({ onComment }: { onComment: (s: PendingSelection) => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const protocol = useAppSelector((s) => s.controls.protocol);
  const barLabels = labelsFor(protocol).filter((l) => BAR.includes(l.id));
  const [sel, setSel] = useState<PendingSelection | null>(null);
  const selNow = useRef<PendingSelection | null>(null);
  selNow.current = sel;
  const onCommentNow = useRef(onComment);
  onCommentNow.current = onComment;
  const dismissed = useRef(false); // Esc / click: the DOM selection stays, so scroll must not bring the button back
  const btn = useRef<HTMLDivElement>(null);
  const switchingNow = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // a tab switch hides the pane the selection is in: the button goes with it
  const activeTab = useAppSelector((s) => s.tabs.active);
  useEffect(() => setSel(null), [activeTab]);
  // mid-switch the comment set belongs to the session being left: no way to start a comment
  const switching = useAppSelector(selectSwitching);
  switchingNow.current = switching;
  useEffect(() => { if (switching) setSel(null); }, [switching]);

  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (btn.current?.contains(e.target as Node)) return;
      // a popup / dialog is open over the text: re-reading the selection would show the button behind it
      if ((e.target as Element | null)?.closest?.('[role="dialog"]')) return;
      dismissed.current = false;
      // the browser updates the selection after mouseup, so read it one tick later
      setTimeout(() => setSel(switchingNow.current ? null : readSelection()));
    };
    const hide = () => setSel(null);
    // capture phase + preventDefault: Esc that dismisses the button must not also interrupt the agent (Composer skips defaultPrevented)
    const onKey = (e: KeyboardEvent) => {
      const s = selNow.current;
      if (!s || e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissed.current = true;
        hide();
        return;
      }
      // type to comment: a printable key (not space, which scrolls) or Enter, outside any field, without shortcuts
      if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
      const typed = e.key.length === 1 && e.key !== ' ';
      if (!typed && e.key !== 'Enter') return;
      e.preventDefault();
      dismissed.current = true;
      onCommentNow.current(typed ? { ...s, text: e.key } : s);
      hide();
    };
    // scroll (also the feed's own autoscroll while streaming): follow the text, hide only when the selection is gone or scrolled out of view.
    // One document-level capture listener filtered to the ACTIVE pane: it follows tab switches without re-binding, and
    // capture also sees nested scrollers (pre, tables), whose scroll does not bubble.
    const onScroll = (e: Event) => {
      if (dismissed.current) return;
      const pane = activePane();
      if (!pane || !(e.target instanceof Node) || !pane.contains(e.target)) return;
      const next = readSelection();
      const view = viewOf();
      setSel(next && attachedInside(next.rect, view) ? next : null);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, { capture: true });
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, { capture: true });
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
  const label = (id: QuickLabelId) => {
    dismissed.current = true;
    dispatch(addComment({ anchor: sel.anchor, text: '', label: id }));
    window.getSelection()?.removeAllRanges();
    dispatch(setPanelOpen(true));
    setSel(null);
  };
  return (
    <div
      ref={btn}
      data-testid="selection-bar"
      className="fixed z-10 flex items-center gap-1 rounded-[10px] border border-border bg-popover p-1 shadow-[0_6px_20px_rgba(0,0,0,0.4)]"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.preventDefault()} // keep the text selected through the click
    >
      <Button
        size="sm"
        className="transition-none"
        onClick={() => {
          dismissed.current = true;
          onComment(sel);
          setSel(null);
        }}
      >
        {t('commentBtn')}
      </Button>
      {barLabels.map((l) => (
        <Tooltip key={l.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={labelText(l.id)}
              onClick={() => label(l.id)}
              className="inline-flex min-h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-sm leading-none hover:bg-accent hover:text-accent-foreground"
            >
              {l.emoji}
            </button>
          </TooltipTrigger>
          <LabelTip id={l.id} />
        </Tooltip>
      ))}
    </div>
  );
}
