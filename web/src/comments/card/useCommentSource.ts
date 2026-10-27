import { isMediaAnchor, type Comment } from '@nota-bene/shared';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { scrollRangeIntoView } from '@/anchors/scroll.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { jumpToFileComment, selectFileLoad, selectFileVersion } from '@/files/slice.ts';
import { activate } from '@/tabs/slice.ts';
import { revealToolOf, TOOL_SRC } from '@/feed/uiSlice.ts';
import { selectReplyLabel, useAppDispatch, useAppSelector, type RootState } from '@/store/store.ts';
import { whereOfFile } from '../send.ts';

const itemRoot = (id: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('[data-item-id]')].find((e) => e.dataset.itemId === id) ?? null;
/** The file tab's own text root: its pane element, carrying `data-file-path` (and `data-file-ref` for another source)
 * while it shows text. A `data-file-path` inside rendered markdown is file content, never a root. */
const fileRoot = (path: string, ref?: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>('[data-pane]')].find((e) => e.dataset.filePath === path && (e.dataset.fileRef ?? '') === (ref ?? '')) ?? null;

/** The source item as the card needs it: missing (null), still streaming, or its text. undefined = not a message source. */
function sourceState(s: RootState, src: Comment['anchor']['source'] | undefined): null | 'streaming' | string | undefined {
  if (src?.kind !== 'message') return undefined;
  if (src.id.startsWith('plan:')) {
    const p = s.feed.items.find((x) => x.kind === 'permission' && `plan:${x.id}` === src.id);
    return p?.kind === 'permission' ? String(p.input.plan ?? '') : null;
  }
  if (src.id.startsWith(TOOL_SRC)) {
    // an action: missing = orphan, like a message; its output arrives once, so "done" is all the card needs to re-check
    const it = s.feed.items.find((x) => x.kind === 'tool' && `${TOOL_SRC}${x.id}` === src.id);
    return it?.kind !== 'tool' ? null : it.result ? 'tool-done' : 'streaming';
  }
  const it = s.feed.items.find((x) => (x.kind === 'assistant' || x.kind === 'user') && x.id === src.id);
  if (!it || (it.kind !== 'assistant' && it.kind !== 'user')) return null;
  return it.kind === 'assistant' && !it.final ? 'streaming' : it.text;
}

/** What a card knows about the place its comment points at. Grows by one field per new source state. */
export interface CommentSource {
  /** The label of the place ("reply 3", "src/a.ts:12"), null when unknown. */
  where: string | null;
  /** The quote can no longer be found in its source. */
  orphan: boolean;
  /** A media comment: the file's current version, known while its tab is open (undefined = unknown, no claim). */
  version: string | undefined;
  /** Show the source: open its file tab, or scroll the chat to the fragment. */
  jump: () => void;
}

/** Where a comment points: its label, whether the quote is still there (orphan), the file version, and the jump. */
export function useCommentSource(c: Comment | undefined): CommentSource {
  const dispatch = useAppDispatch();
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
  const [orphan, setOrphan] = useState(false);

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

  const jump = () => {
    if (!c) return;
    const src = c.anchor.source;
    // a file: open (or activate) its tab; the view scrolls once its text is loaded (files.jump)
    if (src.kind === 'file') return void dispatch(jumpToFileComment(src.path, c.id, src.ref));
    // an action's panel exists only while it and its group are open (R-M7-19): open both, and render, before looking
    const tool = src.id.startsWith(TOOL_SRC);
    if (tool) flushSync(() => { dispatch(activate('chat')); dispatch(revealToolOf(src.id.slice(TOOL_SRC.length))); });
    const root = itemRoot(src.id);
    if (!root) return;
    if (!tool) flushSync(() => dispatch(activate('chat'))); // a hidden chat pane cannot scroll: show it before measuring
    const range = rangeForAnchor(root, c.anchor);
    // a panel's command and output scroll inside their own box: bring the fragment into it first
    const box = range?.startContainer.parentElement?.closest('pre');
    if (range && box && root.contains(box) && box.scrollHeight > box.clientHeight) scrollRangeIntoView(range, box, 'instant');
    const scroller = root.closest<HTMLElement>('[data-chat-pane]');
    if (range && scroller) scrollRangeIntoView(range, scroller); // the fragment itself, not the whole message
    else root.scrollIntoView({ behavior: 'smooth', block: 'center' }); // orphan: the message
    root.classList.remove('nb-flash');
    void root.offsetWidth; // restart the animation
    root.classList.add('nb-flash');
    setTimeout(() => root.classList.remove('nb-flash'), 1300);
  };

  return { where, orphan, version, jump };
}
