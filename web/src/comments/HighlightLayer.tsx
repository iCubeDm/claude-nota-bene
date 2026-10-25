import { useEffect, useRef } from 'react';
import type { Comment } from '@nota-bene/shared';
import { rangeForAnchor } from '@/anchors/text.ts';
import { selectFeed, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { openCommentCard, selectComments } from './slice.ts';

const PAD_X = 2;
const PAD_Y = 1;
const MARK = {
  sent: 'bg-[oklch(0.75_0.18_280/.18)]',
  pending: 'bg-[oklch(0.88_0.18_95/.38)]',
} as const;

/** One rect per line: getClientRects() also returns boxes of nested inline elements, so drop the contained ones. */
function lineRects(range: Range): DOMRect[] {
  const rs = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  return rs.filter(
    (r, i) =>
      !rs.some(
        (o, j) =>
          j !== i && o.left <= r.left + 0.5 && o.right >= r.right - 0.5 && o.top <= r.top + 0.5 && o.bottom >= r.bottom - 0.5 &&
          (o.width * o.height > r.width * r.height || j < i),
      ),
  );
}

type Drawn = { id: string; range: Range };
type Cached = { c: Comment; root: HTMLElement; range: Range };

/**
 * The Range of a comment's text, or null for an orphan / a source that is not (yet) in the DOM or not commentable.
 * A cached range is reused while the comment object and its root element are unchanged and the range is still live;
 * otherwise the anchor is resolved again (one text-model build).
 */
function rangeOf(roots: Map<string, HTMLElement>, cache: Map<string, Cached>, c: Comment): Range | null {
  const { source } = c.anchor;
  if (source.kind !== 'message') return null; // file sources wait for file tabs (M3)
  const root = roots.get(source.id);
  if (!root || (root.dataset.kind === 'assistant' && root.dataset.final !== 'true')) return null;
  const hit = cache.get(c.id);
  if (hit && hit.c === c && hit.root === root && hit.range.startContainer.isConnected && !hit.range.collapsed) return hit.range;
  const range = rangeForAnchor(root, c.anchor);
  if (range) cache.set(c.id, { c, root, range });
  return range;
}

/**
 * Highlight marks over commented text. Lives inside the scrolling chat pane so the marks scroll with the
 * content; the layer ignores pointer events (marks would block text selection), so clicks are hit-tested
 * against the ranges' line rects on the pane in the capture phase.
 */
export function HighlightLayer() {
  const layer = useRef<HTMLDivElement>(null);
  const drawn = useRef<Drawn[]>([]); // topmost last
  const cache = useRef(new Map<string, Cached>());
  const paint = useRef<() => void>(() => {});
  const dispatch = useAppDispatch();
  const comments = useAppSelector(selectComments);
  const feed = useAppSelector(selectFeed);
  const state = useRef({ comments });
  state.current = { comments };

  useEffect(() => {
    const el = layer.current;
    const pane = el?.parentElement;
    const items = pane?.querySelector('#items');
    if (!el || !pane || !items) return;
    let raf = 0;
    const draw = () => {
      raf = 0;
      const base = pane.getBoundingClientRect();
      const list: (Drawn & { kind: 'sent' | 'pending' })[] = [];
      const roots = new Map<string, HTMLElement>();
      for (const e of items.querySelectorAll<HTMLElement>('[data-item-id]')) if (e.dataset.itemId) roots.set(e.dataset.itemId, e);
      const prev = cache.current;
      const next = new Map<string, Cached>(); // only what this paint drew survives: removed / orphaned comments drop out
      for (const c of state.current.comments) {
        const hit = prev.get(c.id);
        if (hit) next.set(c.id, hit);
        const range = rangeOf(roots, next, c);
        if (range) list.push({ id: c.id, range, kind: c.status });
        else next.delete(c.id);
      }
      cache.current = next;
      list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sent' ? -1 : 1)); // pending painted last = on top
      drawn.current = list;
      const nodes: HTMLElement[] = [];
      for (const { range, kind } of list) {
        for (const r of lineRects(range)) {
          const m = document.createElement('div');
          m.dataset.hl = kind;
          m.className = `absolute rounded-[4px] ${MARK[kind]}`;
          m.style.left = `${r.left - base.left + pane.scrollLeft - PAD_X}px`;
          m.style.top = `${r.top - base.top + pane.scrollTop - PAD_Y}px`;
          m.style.width = `${r.width + PAD_X * 2}px`;
          m.style.height = `${r.height + PAD_Y * 2}px`;
          nodes.push(m);
        }
      }
      el.replaceChildren(...nodes);
    };
    paint.current = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => paint.current());
    ro?.observe(pane);
    ro?.observe(items);
    const onLoad = () => paint.current(); // images / video change layout once loaded
    pane.addEventListener('load', onLoad, true);
    void document.fonts?.ready.then(() => paint.current());

    const onClick = (e: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return;
      for (let i = drawn.current.length - 1; i >= 0; i--) {
        const hit = lineRects(drawn.current[i].range).find(
          (r) => e.clientX >= r.left - PAD_X && e.clientX <= r.right + PAD_X && e.clientY >= r.top - PAD_Y && e.clientY <= r.bottom + PAD_Y,
        );
        if (!hit) continue;
        e.stopPropagation();
        e.preventDefault();
        dispatch(openCommentCard({ id: drawn.current[i].id, x: hit.left, y: hit.bottom }));
        return;
      }
    };
    pane.addEventListener('click', onClick, true);
    paint.current();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      pane.removeEventListener('load', onLoad, true);
      pane.removeEventListener('click', onClick, true);
      paint.current = () => {};
    };
  }, [dispatch]);

  // comments or feed changed: React has committed the DOM, repaint on the next frame
  useEffect(() => paint.current(), [comments, feed]);

  return <div ref={layer} aria-hidden="true" data-anchor-skip className="pointer-events-none absolute inset-0" />;
}
