import hljs from 'highlight.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scrollRangeIntoView } from '@/anchors/scroll.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { flashRange, HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { selectComments } from '@/comments/slice.ts';
import { Markdown } from '@/feed/Markdown.tsx';
import { refClick } from '@/refs/refs.ts';
import { useT } from '@/i18n/index.ts';
import { MarkupLayer } from '@/media/markup/MarkupLayer.tsx';
import { selectDraft } from '@/media/markup/slice.ts';
import { selectTurnSeq, useAppDispatch, useAppSelector, useMedia } from '@/store/store.ts';
import { fileTabId } from '@/tabs/slice.ts';
import { fileUrl, kindOf } from './kinds.ts';
import { isFixed, sourcesKnown, useSources } from './sources.ts';
import { SourceChip } from './SourcePicker.tsx';
import { clearJump, dropFileLoad, selectJump, setFileLoad } from './slice.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const PROBE = 8192;
const HIGHLIGHT_MAX = 200_000; // hljs on a 1-2 MB file freezes the tab

type Loaded =
  | { s: 'text'; text: string }
  | { s: 'tooLarge' }
  | { s: 'binary' }
  | { s: 'gone' }
  | { s: 'sourceGone' }
  | { s: 'error'; message: string };

/** HEAD for the size, a Range probe for NUL, only then the whole body. */
/** `other`: another source; the server answers 400 for a source id it does not know (the branch was deleted). */
async function load(url: string, signal: AbortSignal, other: boolean): Promise<Loaded> {
  const head = await fetch(url, { method: 'HEAD', signal });
  if (head.status === 404) return { s: 'gone' };
  if (other && head.status === 400) return { s: 'sourceGone' };
  if (!head.ok) return { s: 'error', message: `${head.status} ${head.statusText}`.trim() };
  if (Number(head.headers.get('content-length') ?? 0) > MAX_BYTES) return { s: 'tooLarge' };
  const probe = await fetch(url, { headers: { Range: `bytes=0-${PROBE - 1}` }, signal });
  if (probe.status === 404) return { s: 'gone' };
  if (!probe.ok) return { s: 'error', message: `${probe.status} ${probe.statusText}`.trim() };
  if (new Uint8Array(await probe.arrayBuffer()).slice(0, PROBE).includes(0)) return { s: 'binary' };
  const res = await fetch(url, { signal });
  if (res.status === 404) return { s: 'gone' };
  if (!res.ok) return { s: 'error', message: `${res.status} ${res.statusText}`.trim() };
  return { s: 'text', text: await res.text() };
}

const extOf = (p: string) => /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase();

function CodeText({ text, path }: { text: string; path: string }) {
  const ref = useRef<HTMLElement>(null);
  const plain = text.length > HIGHLIGHT_MAX;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (plain) {
      el.textContent = text;
      return;
    }
    const ext = extOf(path);
    el.textContent = text;
    delete el.dataset.highlighted;
    el.className = 'hljs';
    if (ext && hljs.getLanguage(ext)) el.classList.add(`language-${ext}`);
    hljs.highlightElement(el);
  }, [text, path, plain]);
  return <code ref={ref} />;
}

/**
 * One open file. `src`/`refName`: another source (a worktree or a branch; M3-16), shown read-only with a chip. A branch
 * view does not reload after a turn (it only changes with a commit); a worktree view does, like this folder's.
 */
export function FileView({ path, active, src = 'here', refName }: { path: string; active: boolean; src?: string; refName?: string }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const kind = kindOf(path);
  const media = kind !== 'md' && kind !== 'text';
  const tabId = fileTabId(path, src);
  const url = fileUrl(path, undefined, src);
  const ref = src === 'here' ? undefined : refName;
  const sources = useSources();
  const fixed = isFixed(src, sources);
  // the tab stays (nothing is dropped or rewritten); its view says the source is gone
  const srcGone = src !== 'here' && sourcesKnown() && !sources.some((x) => x.id === src);
  const turnSeq = useAppSelector(selectTurnSeq);
  const [rev, setRev] = useState(0);
  const [data, setData] = useState<Loaded | null>(null);
  const [natural, setNatural] = useState(false);
  const [failed, setFailed] = useState(false); // image/media could not load
  const [bust, setBust] = useState(0);
  const failedRef = useRef(false);
  failedRef.current = failed;
  const mediaUrl = bust ? `${url}&r=${bust}` : url;
  // the media controller tracks this tab's <video|audio> while it is mounted (pause/PiP rules, the ▶ dot)
  const mediaCtl = useMedia();
  const mediaEl = useRef<HTMLMediaElement | null>(null);
  // the image or video the markup layer draws over (state: the layer mounts once the element exists)
  const [markable, setMarkable] = useState<HTMLImageElement | HTMLVideoElement | null>(null);
  const mediaRef = useCallback((el: HTMLMediaElement | null) => {
    mediaEl.current = el;
    if (el instanceof HTMLVideoElement) setMarkable(el);
    if (!el) return;
    const off = mediaCtl.register(tabId, el);
    return () => {
      off();
      setMarkable(null);
    };
  }, [mediaCtl, tabId]);
  const imgRef = useCallback((el: HTMLImageElement | null) => setMarkable(el), []);
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  // markup (Task 6 turns the drawing into a comment and clears the draft)
  const onMarkAdd = useCallback(() => {}, []);
  // image/media reload: a new cache-busting key; a video/audio resumes where it was (a new src starts at 0)
  const resumeAt = useRef(0);
  const reloadMedia = useCallback(() => {
    const el = mediaEl.current;
    resumeAt.current = el && !el.ended ? el.currentTime : 0;
    setFailed(false);
    setBust((b) => b + 1);
  }, []);

  // a finished turn marks the view stale; the fetch effect below only runs while active, so an inactive view catches up
  // on activation. Media: an image always reloads; a video/audio only while paused (a playing one is not cut off)
  // While marking up, the media is held as it is (the drawing belongs to this frame); leaving catches up.
  const seenTurn = useRef(turnSeq);
  const heldReload = useRef(false);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  useEffect(() => {
    if (seenTurn.current === turnSeq) return;
    seenTurn.current = turnSeq;
    if (fixed) return;
    if (!media) return setRev((r) => r + 1);
    if (markingRef.current) return void (heldReload.current = true);
    const el = mediaEl.current;
    if (kind === 'image' || failedRef.current || !el || el.paused) reloadMedia();
  }, [turnSeq, fixed, media, kind, reloadMedia]);
  useEffect(() => {
    if (marking || !heldReload.current) return;
    heldReload.current = false;
    const el = mediaEl.current;
    if (kind === 'image' || failedRef.current || !el || el.paused) reloadMedia();
  }, [marking, kind, reloadMedia]);
  const onMediaMeta = (e: { currentTarget: HTMLMediaElement }) => {
    if (resumeAt.current > 0) e.currentTarget.currentTime = resumeAt.current;
    resumeAt.current = 0;
  };

  const loadedRev = useRef<{ path: string; rev: number } | null>(null);
  useEffect(() => {
    if (media || !active) return;
    if (loadedRev.current?.path === path && loadedRev.current.rev === rev) return;
    const ac = new AbortController();
    const done = (r: Loaded) => {
      if (ac.signal.aborted) return;
      loadedRev.current = { path, rev }; // an interrupted load stays unmarked and runs again
      setData(r);
    };
    load(url, ac.signal, src !== 'here').then(done, (e: unknown) => done({ s: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => ac.abort();
  }, [media, active, path, rev, url, src]);

  // the load state comments read (orphan or unknown); published after the commit, so the text is in the DOM by then
  useEffect(() => {
    if (media) return;
    dispatch(setFileLoad({ path, ref, s: 'loading' }));
    return () => void dispatch(dropFileLoad({ path, ref })); // tab closed: its comments go back to "unknown"
  }, [media, path, ref, dispatch]);
  useEffect(() => {
    if (media || !data) return;
    // transient, or a deleted source (it may come back): neither loaded nor gone
    if (data.s === 'error' || data.s === 'sourceGone') dispatch(setFileLoad({ path, ref, s: 'loading' }));
    else dispatch(setFileLoad({ path, ref, s: data.s === 'text' ? 'loaded' : 'gone' }));
  }, [media, data, path, ref, dispatch]);

  // "jump to source" (CommentCard): once this view shows fresh text and is visible, scroll to the fragment and flash it
  const jump = useAppSelector(selectJump);
  const comments = useAppSelector(selectComments);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jump?.path !== path || jump.src !== src || !active || !data) return;
    const fresh = loadedRev.current?.path === path && loadedRev.current.rev === rev;
    if (!fresh) return; // a stale view reloads on activation: wait for that load
    dispatch(clearJump());
    const c = comments.find((x) => x.id === jump.id);
    const el = pane.current;
    if (!c || !el || data.s !== 'text') return;
    const range = rangeForAnchor(el, c.anchor);
    if (!range) return; // orphaned: the tab is open, nothing to point at
    scrollRangeIntoView(range, el);
    flashRange(el, range);
  }, [jump, active, data, rev, path, src, comments, dispatch]);

  const note = (key: 'tooLarge' | 'binary' | 'fileGone') => (
    <p className="p-4 text-sm text-muted-foreground">
      {t(key)}
      {key !== 'fileGone' && (
        <> · <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t('openRaw')}</a></>
      )}
    </p>
  );

  const gone = <p className="p-4 text-sm text-muted-foreground">{t('fileGone')}</p>;
  const onError = () => setFailed(true);
  const large = data?.s === 'text' && kind === 'text' && data.text.length > HIGHLIGHT_MAX;

  const goneSrc = <p data-source-gone className="p-4 text-sm text-muted-foreground">{t('sourceGone')}</p>;

  let body;
  if (media && (failed || srcGone)) {
    body = <div data-pane={tabId} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">{srcGone ? goneSrc : gone}</div>;
  } else if (kind === 'image') {
    body = (
      // M3-13 relies on data-pane as the pane's scroll container; data-file-path (text/md only) marks the text root
      <div data-pane={tabId} hidden={!active} className={`grid-pane nb-media-pane relative min-h-0 flex-1 overflow-auto${natural ? ' nb-natural' : ''}`}>
        <img
          ref={imgRef}
          src={mediaUrl}
          alt={path}
          onError={onError}
          onClick={() => marking || setNatural((v) => !v)}
          className={`nb-fit ${marking ? '' : natural ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}
        />
      </div>
    );
  } else if (kind === 'video' || kind === 'audio') {
    body = (
      <div data-pane={tabId} hidden={!active} className={`grid-pane nb-media-pane relative min-h-0 flex-1 overflow-auto`}>
        {/* while marking up, no native controls: the frame stays still, so the drawing and currentTime agree */}
        {kind === 'video' ? (
          <video ref={mediaRef} controls={!marking} preload="metadata" src={mediaUrl} onError={onError} onLoadedMetadata={onMediaMeta} data-media-tab={tabId} className="nb-fit" />
        ) : (
          <audio ref={mediaRef} controls src={mediaUrl} onError={onError} onLoadedMetadata={onMediaMeta} data-media-tab={tabId} className="w-full max-w-xl p-4" />
        )}
      </div>
    );
  } else {
    const inner =
      data == null ? null
      : data.s === 'text' ? (
        kind === 'md' ? <div className="nb-card nb-prose px-10 pt-5 pb-7" onClick={(e) => refClick(e, dispatch, src)}><Markdown text={data.text} final src={src} baseDir={path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined} /></div>
        : <pre className="nb-card nb-code overflow-x-auto p-4 font-mono text-xs leading-relaxed whitespace-pre"><CodeText text={data.text} path={path} /></pre>
      )
      : data.s === 'error' ? <p className="p-4 text-sm text-destructive">{data.message}</p>
      : data.s === 'sourceGone' ? goneSrc
      : note(data.s === 'gone' ? 'fileGone' : data.s);
    body = (
      // data-file-path only while the text is shown: a note or an error is not commentable and has no anchors
      <div ref={pane} data-pane={tabId} data-file-path={data?.s === 'text' ? path : undefined} data-file-ref={ref} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {inner}
        <HighlightLayer pane={tabId} />
      </div>
    );
  }

  return (
    <div hidden={!active} className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex">
      <div data-anchor-skip className="flex h-8 flex-none items-center gap-2 border-b border-border-soft bg-chrome px-3 font-mono text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={ref ? `${path} @ ${ref}` : path}>{path}</span>
        {ref && <SourceChip name={ref} />}
        {large && <span>{t('noHighlight')}</span>}
        <button type="button" aria-label={t('reload')} title={t('reload')} onClick={() => (media ? reloadMedia() : setRev((r) => r + 1))} className="rounded px-1.5 hover:bg-muted hover:text-foreground">↻</button>
        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">{t('openRaw')}</a>
      </div>
      {(kind === 'image' || kind === 'video') && !failed && !srcGone ? (
        // the toolbar sits over the pane but outside its scroll, so it stays in the corner in natural size
        <div className="relative flex min-h-0 flex-1 flex-col">
          {body}
          {markable && <MarkupLayer tabId={tabId} media={markable} fit={kind === 'image' && natural ? 'natural' : 'contain'} onAdd={onMarkAdd} />}
        </div>
      ) : body}
    </div>
  );
}
