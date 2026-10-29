import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { selectMediaComments } from '@/comments/slice.ts';
import { selectTurnSeq, useAppDispatch, useAppSelector } from '@/store/store.ts';
import type { FileKind } from '../kinds.ts';
import { fileTabId } from '@/tabs/slice.ts';
import { takeStartAt, type StartAt } from '../startAt.ts';
import { dropFileLoad, setFileLoad, setFileVersion } from '../slice.ts';

const MAX_BYTES = 2 * 1024 * 1024;
const PROBE = 8192;

/** Applies a chat "open in a tab" start; one that was playing plays on (the click was the user's gesture). */
function startFrom(el: HTMLMediaElement, s: StartAt | undefined) {
  if (!s) return;
  el.currentTime = s.at;
  if (s.play) el.play().catch(() => { /* refused (no activation, headless): stays paused at that time */ });
}

export type Loaded =
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

/** The media's ETag (its version for media comments); undefined without one (a branch source) or on any failure. */
export const headVersion = (url: string, signal: AbortSignal): Promise<string | undefined> => fetch(url, { method: 'HEAD', signal }).then(
  (r) => (r.ok ? r.headers.get('etag') ?? undefined : undefined),
  () => undefined, // no version: the mark simply cannot tell "the file changed"
);

/**
 * The file's content and its reloads: the text load (HEAD → Range probe → GET) with its comment-facing load state, the
 * media's cache-busting `bust` / `failed` / resume point, the refresh after a turn (held while marking up) and the
 * file version media comments compare against.
 */
export function useFileLoad({ path, src, ref, url, kind, media, hasVersion, active, fixed, marking, markingRef }: {
  path: string; src: string; ref: string | undefined; url: string; kind: FileKind; media: boolean; hasVersion: boolean;
  active: boolean; fixed: boolean; marking: boolean; markingRef: MutableRefObject<boolean>;
}) {
  const dispatch = useAppDispatch();
  const turnSeq = useAppSelector(selectTurnSeq);
  const [rev, setRev] = useState(0);
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false); // image/media could not load
  const [bust, setBust] = useState(0);
  const failedRef = useRef(false);
  failedRef.current = failed;
  const mediaUrl = bust ? `${url}&r=${bust}` : url;
  const mediaEl = useRef<HTMLMediaElement | null>(null);
  // the file's current version, for its media comments' "the file has changed since": read when the media (re)loads,
  // only while the file has a media comment that knows its own version (no request for a file without one)
  const versioned = useAppSelector((s) => hasVersion && selectMediaComments(s, path, ref).some((c) => c.anchor.version !== undefined));
  useEffect(() => {
    if (!versioned) return;
    const ac = new AbortController();
    void headVersion(mediaUrl, ac.signal).then((v) => ac.signal.aborted || dispatch(setFileVersion({ path, ref, version: v })));
    return () => ac.abort();
  }, [versioned, mediaUrl, path, ref, dispatch]);
  useEffect(() => () => void dispatch(setFileVersion({ path, ref })), [path, ref, dispatch]); // the tab closed: unknown
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
  useEffect(() => {
    if (seenTurn.current === turnSeq) return;
    seenTurn.current = turnSeq;
    if (fixed) return;
    if (!media) return setRev((r) => r + 1);
    if (markingRef.current) return void (heldReload.current = true);
    const el = mediaEl.current;
    if (kind === 'image' || failedRef.current || !el || el.paused) reloadMedia();
  }, [turnSeq, fixed, media, kind, reloadMedia, markingRef]);
  useEffect(() => {
    if (marking || !heldReload.current) return;
    heldReload.current = false;
    const el = mediaEl.current;
    if (kind === 'image' || failedRef.current || !el || el.paused) reloadMedia();
  }, [marking, kind, reloadMedia]);
  // the header ↻: like a finished turn, held while marking up (the drawing belongs to the frame on screen)
  const reloadClick = () => {
    if (!media) return setRev((r) => r + 1);
    if (markingRef.current) return void (heldReload.current = true);
    reloadMedia();
  };
  const tabId = fileTabId(path, src);
  const onMediaMeta = (e: { currentTarget: HTMLMediaElement }) => {
    if (resumeAt.current > 0) e.currentTarget.currentTime = resumeAt.current;
    resumeAt.current = 0;
    startFrom(e.currentTarget, takeStartAt(tabId)); // "open in a tab" from the chat: a fresh tab starts here
  };
  // the same tab already open with its media loaded: no new loadedmetadata, so apply on (re)activation
  useEffect(() => {
    const el = mediaEl.current;
    if (!active || !media || !el || el.readyState < 1) return;
    startFrom(el, takeStartAt(tabId));
  }, [active, media, tabId]);

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

  return { data, rev, loadedRev, failed, bust, onError: () => setFailed(true), mediaUrl, mediaEl, resumeAt, reloadClick, onMediaMeta };
}
