import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { type MediaAnchor, type MediaShape } from '@nota-bene/shared';
import type { PendingComment } from '@/comments/CommentPopup.tsx';
import { useT } from '@/i18n/index.ts';
import { toast } from '@/shell/toast.ts';
import { prepareMediaComment } from '@/media/markup/createMediaComment.ts';
import { dropShapes } from '@/media/markup/slice.ts';
import { useAppDispatch, useMedia } from '@/store/store.ts';
import { headVersion } from './useFileLoad.ts';

/**
 * The media pane's markup side: which element the markup layer draws over, the media controller registration, and the
 * popup a drawing's Add opens. `mediaEl` is the file load's ref to the playing element (it reads it to reload).
 */
export function useMediaMarkup({ tabId, path, ref, active, marking, mediaUrl, mediaEl }: {
  tabId: string; path: string; ref: string | undefined; active: boolean; marking: boolean; mediaUrl: string;
  mediaEl: MutableRefObject<HTMLMediaElement | null>;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  // the media controller tracks this tab's <video|audio> while it is mounted (pause/PiP rules, the ▶ dot)
  const mediaCtl = useMedia();
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
  }, [mediaCtl, tabId, mediaEl]);
  const imgRef = useCallback((el: HTMLImageElement | null) => setMarkable(el), []);
  // markup → comment. The version is the media's ETag, asked for when the mode is entered (absent for a branch
  // source); prepare awaits that request, so an early Add still gets it. Nothing is written until Add (the popup runs
  // `prepare` then), and the draft is cleared only once the comment exists.
  const version = useRef<Promise<string | undefined> | undefined>(undefined);
  useEffect(() => {
    version.current = undefined;
    if (!marking) return;
    const ac = new AbortController();
    version.current = headVersion(mediaUrl, ac.signal);
    return () => ac.abort();
  }, [marking, mediaUrl]);
  const [markPopup, setMarkPopup] = useState<PendingComment | null>(null);
  const onMarkAdd = useCallback((shapes: MediaShape[], at: DOMRect) => {
    const el = markable;
    if (!el) return;
    const video = el instanceof HTMLVideoElement;
    const [width, height] = video ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
    // not loaded yet, or no intrinsic size (an SVG without one): nothing to render the drawing on; the draft stays
    if (!width || !height) return toast(t('markNoSize'), path);
    const anchor: MediaAnchor = {
      kind: 'media', source: ref === undefined ? { kind: 'file', path } : { kind: 'file', path, ref }, width, height,
      // for the popup's quote; prepare pauses the video and re-reads the time at the moment it captures the frame
      ...(video && { time: Math.round(el.currentTime * 1000) / 1000 }),
      shapes,
    };
    const id = crypto.randomUUID();
    const v = version.current;
    setMarkPopup({ anchor, rect: at, id, prepare: () => prepareMediaComment(id, el, anchor, { version: v }) });
  }, [markable, path, ref, t]);
  const closeMarkPopup = useCallback(() => setMarkPopup(null), []);
  // only the shapes that went into the comment leave the draft (a stroke drawn meanwhile is not the comment's)
  const markAdded = useCallback((shapes: MediaShape[]) => void dispatch(dropShapes(tabId, shapes)), [dispatch, tabId]);
  // the popup belongs to a visible drawing: hiding the tab or leaving the mode closes it (the draft stays). Not while
  // its Add is saving: that finishes (the popup waits hidden; a failure is shown there, and as a toast)
  // state too: while saving, the markup layer takes no drawing, no Comment and no keys
  const [saving, setSaving] = useState(false);
  const popupBusy = useRef(false);
  const onPopupBusy = useCallback((b: boolean) => void ((popupBusy.current = b), setSaving(b)), []);
  useEffect(() => {
    if ((!active || !marking) && !popupBusy.current) setMarkPopup(null);
  }, [active, marking]);

  return { markable, mediaRef, imgRef, markPopup, onMarkAdd, closeMarkPopup, markAdded, saving, onPopupBusy };
}

export type MediaMarkup = ReturnType<typeof useMediaMarkup>;
