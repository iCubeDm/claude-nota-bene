import hljs from 'highlight.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { scrollRangeIntoView } from '@/anchors/scroll.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { flashRange, HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { selectComments } from '@/comments/slice.ts';
import { Markdown } from '@/feed/Markdown.tsx';
import { refClick } from '@/refs/refs.ts';
import { useT } from '@/i18n/index.ts';
import { selectTurnSeq, useAppDispatch, useAppSelector, useMedia } from '@/store/store.ts';
import { fileTabId } from '@/tabs/slice.ts';
import { fileUrl, kindOf } from './kinds.ts';
import { clearJump, dropFileLoad, selectJump, setFileLoad } from './slice.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const PROBE = 8192;
const HIGHLIGHT_MAX = 200_000; // hljs on a 1-2 MB file freezes the tab

type Loaded =
  | { s: 'text'; text: string }
  | { s: 'tooLarge' }
  | { s: 'binary' }
  | { s: 'gone' }
  | { s: 'error'; message: string };

/** HEAD for the size, a Range probe for NUL, only then the whole body. */
async function load(url: string, signal: AbortSignal): Promise<Loaded> {
  const head = await fetch(url, { method: 'HEAD', signal });
  if (head.status === 404) return { s: 'gone' };
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

export function FileView({ path, active }: { path: string; active: boolean }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const kind = kindOf(path);
  const media = kind !== 'md' && kind !== 'text';
  const tabId = fileTabId(path);
  const url = fileUrl(path);
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
  const mediaRef = useCallback((el: HTMLMediaElement | null) => (el ? mediaCtl.register(tabId, el) : undefined), [mediaCtl, tabId]);

  // a finished turn marks the view stale; the fetch effect below only runs while active, so an inactive view catches up on activation
  const seenTurn = useRef(turnSeq);
  useEffect(() => {
    if (seenTurn.current === turnSeq) return;
    seenTurn.current = turnSeq;
    setRev((r) => r + 1);
  }, [turnSeq]);

  // image/media: a reload only matters after a failed load; it retries under a new cache-busting key
  useEffect(() => {
    if (!media || rev === 0 || !failedRef.current) return;
    setFailed(false);
    setBust((b) => b + 1);
  }, [media, rev]);

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
    load(url, ac.signal).then(done, (e: unknown) => done({ s: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => ac.abort();
  }, [media, active, path, rev, url]);

  // the load state comments read (orphan or unknown); published after the commit, so the text is in the DOM by then
  useEffect(() => {
    if (media) return;
    dispatch(setFileLoad({ path, s: 'loading' }));
    return () => void dispatch(dropFileLoad(path)); // tab closed: its comments go back to "unknown"
  }, [media, path, dispatch]);
  useEffect(() => {
    if (media || !data) return;
    if (data.s === 'error') dispatch(setFileLoad({ path, s: 'loading' })); // transient: neither loaded nor gone
    else dispatch(setFileLoad({ path, s: data.s === 'text' ? 'loaded' : 'gone' }));
  }, [media, data, path, dispatch]);

  // "jump to source" (CommentCard): once this view shows fresh text and is visible, scroll to the fragment and flash it
  const jump = useAppSelector(selectJump);
  const comments = useAppSelector(selectComments);
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (jump?.path !== path || !active || !data) return;
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
  }, [jump, active, data, rev, path, comments, dispatch]);

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

  let body;
  if (media && failed) {
    body = <div data-pane={tabId} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">{gone}</div>;
  } else if (kind === 'image') {
    body = (
      // M3-13 relies on data-pane as the pane's scroll container; data-file-path (text/md only) marks the text root
      <div data-pane={tabId} hidden={!active} className={`grid-pane relative min-h-0 flex-1 overflow-auto ${natural ? '' : '[&:not([hidden])]:grid place-items-center'}`}>
        <img
          src={mediaUrl}
          alt={path}
          onError={onError}
          onClick={() => setNatural((v) => !v)}
          className={natural ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain'}
        />
      </div>
    );
  } else if (kind === 'video' || kind === 'audio') {
    body = (
      <div data-pane={tabId} hidden={!active} className="grid-pane relative [&:not([hidden])]:grid min-h-0 flex-1 place-items-center overflow-auto p-4">
        {kind === 'video' ? (
          <video ref={mediaRef} controls preload="metadata" src={mediaUrl} onError={onError} data-media-tab={tabId} className="max-h-full max-w-full" />
        ) : (
          <audio ref={mediaRef} controls src={mediaUrl} onError={onError} data-media-tab={tabId} className="w-full max-w-xl" />
        )}
      </div>
    );
  } else {
    const inner =
      data == null ? null
      : data.s === 'text' ? (
        kind === 'md' ? <div className="mx-auto max-w-3xl p-4" onClick={(e) => refClick(e, dispatch)}><Markdown text={data.text} final baseDir={path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined} /></div>
        : <pre className="m-0 p-4 font-mono text-xs leading-relaxed whitespace-pre"><CodeText text={data.text} path={path} /></pre>
      )
      : data.s === 'error' ? <p className="p-4 text-sm text-destructive">{data.message}</p>
      : note(data.s === 'gone' ? 'fileGone' : data.s);
    body = (
      // data-file-path only while the text is shown: a note or an error is not commentable and has no anchors
      <div ref={pane} data-pane={tabId} data-file-path={data?.s === 'text' ? path : undefined} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {inner}
        <HighlightLayer pane={tabId} />
      </div>
    );
  }

  return (
    <div hidden={!active} className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex">
      <div data-anchor-skip className="flex h-8 flex-none items-center gap-2 border-b border-border-soft bg-chrome px-3 font-mono text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={path}>{path}</span>
        {large && <span>{t('noHighlight')}</span>}
        <button type="button" aria-label={t('reload')} title={t('reload')} onClick={() => setRev((r) => r + 1)} className="rounded px-1.5 hover:bg-muted hover:text-foreground">↻</button>
        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">{t('openRaw')}</a>
      </div>
      {body}
    </div>
  );
}
