import { useEffect, useRef, useState } from 'react';
import { isMediaAnchor } from '@nota-bene/shared';
import { scrollRangeIntoView } from '@/anchors/scroll.ts';
import { rangeForAnchor } from '@/anchors/text.ts';
import { flashRange } from '@/comments/HighlightLayer.tsx';
import { selectComments } from '@/comments/slice.ts';
import { useT } from '@/i18n/index.ts';
import { seekAndPause } from '@/media/mediaController.ts';
import { selectDraft } from '@/media/markup/slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { fileTabId } from '@/tabs/slice.ts';
import { fileUrl, kindOf } from './kinds.ts';
import { isFixed, sourcesKnown, useSources } from './sources.ts';
import { SourceChip } from './SourcePicker.tsx';
import { clearJump, selectJump } from './slice.ts';
import { HIGHLIGHT_MAX } from './view/CodeText.tsx';
import { MediaBody } from './view/MediaBody.tsx';
import { TextBody } from './view/TextBody.tsx';
import { useFileLoad } from './view/useFileLoad.ts';
import { useMediaMarkup } from './view/useMediaMarkup.ts';

/**
 * One open file. `src`/`refName`: another source (a worktree or a branch; M3-16), shown read-only with a chip. A branch
 * view does not reload after a turn (it only changes with a commit); a worktree view does, like this folder's.
 */
export function FileView({ path, active, src = 'here', refName }: { path: string; active: boolean; src?: string; refName?: string }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const kind = kindOf(path);
  const media = kind !== 'md' && kind !== 'text';
  const markableKind = kind === 'image' || kind === 'video';
  const tabId = fileTabId(path, src);
  const url = fileUrl(path, undefined, src);
  const ref = src === 'here' ? undefined : refName;
  const sources = useSources();
  const fixed = isFixed(src, sources);
  // the tab stays (nothing is dropped or rewritten); its view says the source is gone
  const srcGone = src !== 'here' && sourcesKnown() && !sources.some((x) => x.id === src);
  const [natural, setNatural] = useState(false);
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const load = useFileLoad({ path, src, ref, url, kind, media, markableKind, active, fixed, marking, markingRef });
  const { data, rev, loadedRev, failed, mediaUrl, resumeAt } = load;
  const markup = useMediaMarkup({ tabId, path, ref, active, marking, mediaUrl, mediaEl: load.mediaEl });
  const { markable } = markup;

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
  }, [jump, active, data, rev, path, src, comments, dispatch, loadedRev]);

  // "jump to source" on a media tab: the tab is open and active; a video also seeks to the comment's time and pauses
  // (not while marking: the drawing belongs to the frame on screen)
  useEffect(() => {
    if (!markableKind || jump?.path !== path || jump.src !== src || !active || !markable) return;
    dispatch(clearJump());
    const c = comments.find((x) => x.id === jump.id);
    if (!c || !isMediaAnchor(c.anchor) || c.anchor.time === undefined || !(markable instanceof HTMLVideoElement) || markingRef.current) return;
    resumeAt.current = 0; // the jump's time wins over a reload's resume point
    seekAndPause(markable, c.anchor.time);
  }, [markableKind, jump, active, markable, path, src, comments, dispatch, resumeAt]);

  const large = data?.s === 'text' && kind === 'text' && data.text.length > HIGHLIGHT_MAX;

  return (
    <div hidden={!active} className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex">
      <div data-anchor-skip className="flex h-8 flex-none items-center gap-2 border-b border-border-soft bg-chrome px-3 font-mono text-[11.5px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={ref ? `${path} @ ${ref}` : path}>{path}</span>
        {ref && <SourceChip name={ref} />}
        {large && <span>{t('noHighlight')}</span>}
        <button type="button" aria-label={t('reload')} title={t('reload')} onClick={load.reloadClick} className="rounded px-1.5 hover:bg-muted hover:text-foreground">↻</button>
        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">{t('openRaw')}</a>
      </div>
      {media ? (
        <MediaBody
          kind={kind} path={path} fileRef={ref} tabId={tabId} active={active} marking={marking} natural={natural}
          onToggleNatural={() => setNatural((v) => !v)} mediaUrl={mediaUrl} failed={failed} srcGone={srcGone}
          onError={load.onError} onMediaMeta={load.onMediaMeta} markup={markup}
        />
      ) : (
        <TextBody data={data} kind={kind} path={path} src={src} fileRef={ref} tabId={tabId} active={active} url={url} paneRef={pane} />
      )}
    </div>
  );
}
