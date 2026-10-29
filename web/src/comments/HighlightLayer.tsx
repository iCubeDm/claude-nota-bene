import { useEffect, useMemo, useRef } from 'react';
import { isMediaAnchor, type Comment } from '@nota-bene/shared';
import { rangeForAnchor } from '@/anchors/text.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { fileKey } from '@/files/sources.ts';
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
type Source = Comment['anchor']['source'];

/** The file a file pane shows: its path and, for another source, the ref (M3-16). undefined = the chat. */
type PaneFile = { path: string; ref?: string } | undefined;

/**
 * Whether a source lives in this pane: message sources in the chat (those of a subagent's conversation in that
 * subagent's tab: `agent`), a file source in the tab of that path AND ref.
 */
const inPane = (src: Source, file: PaneFile, agent?: string): boolean =>
  file === undefined ? src.kind === 'message' && src.agent === agent : src.kind === 'file' && src.path === file.path && (src.ref ?? '') === (file.ref ?? '');

/**
 * The commentable roots inside a pane, keyed by source: the chat's items (by id), or the file view's own text root:
 * the pane element itself, while FileView marks it with this tab's path and ref (only while it shows text). A
 * `data-file-path` inside rendered markdown is file content and never a root.
 */
function rootsIn(pane: HTMLElement, file: PaneFile | null): Map<string, HTMLElement> {
  const roots = new Map<string, HTMLElement>();
  if (file === undefined) {
    for (const e of pane.querySelectorAll<HTMLElement>('#items [data-item-id], [data-items] [data-item-id]')) if (e.dataset.itemId) roots.set(`m:${e.dataset.itemId}`, e);
  } else if (file && pane.dataset.filePath === file.path && (pane.dataset.fileRef ?? '') === (file.ref ?? '')) {
    roots.set(`f:${fileKey(file.path, file.ref)}`, pane);
  }
  return roots;
}
const keyOf = (src: Source) => (src.kind === 'message' ? `m:${src.id}` : `f:${fileKey(src.path, src.ref)}`);

/**
 * The Range of a comment's text, or null for an orphan / a source that is not (yet) in the DOM or not commentable.
 * A cached range is reused while the comment object and its root element are unchanged and the range is still live;
 * otherwise the anchor is resolved again (one text-model build). A file reload with new text replaces the text nodes
 * (Markdown sets innerHTML, CodeText sets textContent), so `isConnected` drops the stale range; an unchanged text keeps them.
 */
function rangeOf(roots: Map<string, HTMLElement>, cache: Map<string, Cached>, c: Comment): Range | null {
  if (isMediaAnchor(c.anchor)) return null; // media marks are drawn over the media, not as text highlights
  const root = roots.get(keyOf(c.anchor.source));
  if (!root || (root.dataset.kind === 'assistant' && root.dataset.final !== 'true')) return null;
  const hit = cache.get(c.id);
  if (hit && hit.c === c && hit.root === root && hit.range.startContainer.isConnected && !hit.range.collapsed) return hit.range;
  const range = rangeForAnchor(root, c.anchor);
  if (range) cache.set(c.id, { c, root, range });
  return range;
}

/** Positions one box per line of `range`, in the coordinates of a layer at the pane's content origin. */
function boxes(range: Range, pane: HTMLElement, className: string, data?: Record<string, string>): HTMLElement[] {
  const base = pane.getBoundingClientRect();
  return lineRects(range).map((r) => {
    const m = document.createElement('div');
    if (data) Object.assign(m.dataset, data);
    m.className = `absolute rounded-[4px] ${className}`;
    m.style.left = `${r.left - base.left + pane.scrollLeft - PAD_X}px`;
    m.style.top = `${r.top - base.top + pane.scrollTop - PAD_Y}px`;
    m.style.width = `${r.width + PAD_X * 2}px`;
    m.style.height = `${r.height + PAD_Y * 2}px`;
    return m;
  });
}

/** A one-off flash over a fragment (jump to source in a file): drawn in the pane's layer, apart from the marks it repaints. */
export function flashRange(pane: HTMLElement, range: Range) {
  const host = pane.querySelector<HTMLElement>(':scope > [data-hl-layer] > [data-hl-flash]');
  if (!host) return;
  const nodes = boxes(range, pane, 'nb-flash');
  host.append(...nodes);
  setTimeout(() => nodes.forEach((n) => n.remove()), 1300);
}

/**
 * Highlight marks over commented text, one layer per pane (`pane` is the tab id: 'chat' or a file tab). Lives inside
 * the pane's scroll element so the marks scroll with the content, and paints only the comments whose source lives in
 * that pane. A hidden pane paints nothing (its rects are all zero) and repaints when it becomes active. The layer
 * ignores pointer events (marks would block text selection), so clicks are hit-tested against the ranges' line rects
 * on the pane in the capture phase.
 */
export function HighlightLayer({ pane: paneId = 'chat' }: { pane?: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const marks = useRef<HTMLDivElement>(null);
  const drawn = useRef<Drawn[]>([]); // topmost last
  const cache = useRef(new Map<string, Cached>());
  const paint = useRef<() => void>(() => {});
  const dispatch = useAppDispatch();
  const all = useAppSelector(selectComments);
  const active = useAppSelector((s) => s.tabs.active === paneId);
  // the file this pane shows (path + ref); null = a file pane whose tab is gone
  const path = useAppSelector((s) => {
    const tab = s.tabs.open.find((t) => t.id === paneId);
    return tab?.kind === 'file' ? tab.path : undefined;
  });
  const ref = useAppSelector((s) => {
    const tab = s.tabs.open.find((t) => t.id === paneId);
    return tab?.kind === 'file' ? tab.ref : undefined;
  });
  // a subagent's tab (`agent:<toolUseId>`) draws its conversation like the chat; its comments carry `source.agent`
  const agent = paneId.startsWith('agent:') ? paneId.slice('agent:'.length) : undefined;
  const asChat = paneId === 'chat' || agent !== undefined;
  const file: PaneFile | null = useMemo(() => (asChat ? undefined : path === undefined ? null : { path, ref }), [asChat, path, ref]);
  const comments = useMemo(() => (file === null ? [] : all.filter((c) => inPane(c.anchor.source, file, agent))), [all, file, agent]);
  // what moves this pane's text: the feed for the chat (the subagent's entry for its tab); a settled (re)load for a file tab
  const content = useAppSelector((s) => (agent ? s.subagents.byTool[agent] : paneId === 'chat' ? s.feed : path === undefined ? undefined : s.files.load[fileKey(path, ref)]));
  // the chat's action panels open and close without a feed change (their roots come and go)
  const folds = useAppSelector((s) => (asChat ? s.feedUi : undefined));
  const state = useRef({ comments, active, file });
  state.current = { comments, active, file };

  useEffect(() => {
    const el = layer.current;
    const pane = el?.parentElement;
    const host = marks.current;
    if (!el || !pane || !host) return;
    let raf = 0;
    // layout changes that do not resize the pane: the chat's #items, and a file root's content (it is the scroll element itself)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => paint.current());
    const observed = new WeakSet<Element>();
    const observe = (e: Element) => {
      if (!observed.has(e)) { observed.add(e); ro?.observe(e); }
    };
    const draw = () => {
      raf = 0;
      if (!state.current.active) {
        drawn.current = [];
        host.replaceChildren();
        return; // the cache is kept: its ranges stay valid while hidden, and are re-checked on the next paint
      }
      const list: (Drawn & { kind: 'sent' | 'pending' })[] = [];
      const roots = rootsIn(pane, state.current.file);
      for (const [k, r] of roots) if (k.startsWith('f:')) for (const e of r.children) if (!e.hasAttribute('data-hl-layer')) observe(e);
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
      host.replaceChildren(...list.flatMap(({ range, kind }) => boxes(range, pane, MARK[kind], { hl: kind })));
    };
    paint.current = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    observe(pane);
    const items = pane.querySelector('#items, [data-items]');
    if (items) observe(items);
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

  // comments, content or visibility changed: React has committed the DOM (and unhidden the pane), repaint on the next frame
  useEffect(() => paint.current(), [comments, content, folds, active]);

  return (
    <div ref={layer} aria-hidden="true" data-anchor-skip data-hl-layer={paneId} className="pointer-events-none absolute inset-0">
      <div ref={marks} />
      <div data-hl-flash />
    </div>
  );
}
