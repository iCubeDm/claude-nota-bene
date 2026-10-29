import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { isMediaAnchor, type MediaAnchor, type MediaShape } from '@nota-bene/shared';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { type MediaComment, selectMediaComments } from '@/comments/slice.ts';
import { keysInScope } from '@/lib/keyScope.ts';
import { useT } from '@/i18n/index.ts';
import { inPlayerScope } from '@/media/playerKeys.ts';
import { prepareMediaComment } from '@/media/markup/createMediaComment.ts';
import { MarkupLayer } from '@/media/markup/MarkupLayer.tsx';
import { changedSince, MediaMarks } from '@/media/markup/MediaMarks.tsx';
import { selectDraft, setMode } from '@/media/markup/slice.ts';
import type { CameraPose, ModelViewer } from '@/model/api.ts';
import { MODEL_MARKUP_PROTOCOL, nearPose } from '@/model/pose.ts';
import { getViewPose, subscribeViewPose } from '@/model/registry.ts';
import { toast } from '@/shell/toast.ts';
import { clearJump, selectFileVersion, selectJump } from '../slice.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { useMarkPopup } from './useMediaMarkup.ts';

/** The ids of the comments whose camera the view is at, as one string: it changes only when the set does (no re-render per mouse move). */
const atKey = (all: MediaComment[], pose: CameraPose | undefined): string =>
  pose ? all.filter((c) => c.anchor.camera && nearPose(c.anchor.camera, pose)).map((c) => c.id).join(',') : '';

const CHIP_CHARS = 18;

/**
 * Margin comments on a model tab (step B), over the viewer's canvas. Markup mode freezes the orbit controls (and pauses a
 * playing clip) and draws on top of the canvas, like the paused-frame mode of a video; the comment carries the camera and
 * the canvas snapshot at that pose. The marks of a comment show only while the camera is at its pose; every comment is
 * also a chip over the canvas, and a click on it brings the camera back to that view (the way a video's timeline tick
 * seeks). "Jump to source" does the same once the model is ready. A sent comment whose file changed since is dimmed and
 * not drawn, as for images.
 */
export function ModelMarkup({ tabId, path, src, fileRef, url, active, viewer, ready, playing, onPause, onMarking }: {
  tabId: string; path: string; src: string; fileRef: string | undefined; url: string; active: boolean;
  viewer: ModelViewer | null; ready: boolean; playing: boolean; onPause: () => void; onMarking: (marking: boolean) => void;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const marking = useAppSelector((s) => selectDraft(s, tabId).on);
  const offered = useAppSelector((s) => s.controls.protocol >= MODEL_MARKUP_PROTOCOL);
  const all = useAppSelector((s) => selectMediaComments(s, path, fileRef));
  const current = useAppSelector((s) => selectFileVersion(s, path, fileRef));
  const canvas = viewer?.canvas ?? null;

  // ---- the camera follows nothing while a drawing is made over it ----
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    if (!viewer || !marking) return;
    viewer.setFrozen(true);
    if (playingRef.current) { viewer.setPlaying(false); onPause(); } // one still frame: the clip time is not part of the comment
    return () => viewer.setFrozen(false);
  }, [viewer, marking, onPause]);
  useEffect(() => void onMarking(marking), [marking, onMarking]);

  // ---- N enters the mode (the video's key) ----
  useEffect(() => {
    if (!active || marking || !offered || !ready || !canvas) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyN' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !keysInScope(e, canvas, inPlayerScope)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) dispatch(setMode(tabId, true));
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, marking, offered, ready, canvas, dispatch, tabId]);

  // ---- which comments' marks are at the view now ----
  const sub = useCallback((f: () => void) => subscribeViewPose(tabId, f), [tabId]);
  const key = useSyncExternalStore(sub, () => atKey(all, getViewPose(tabId)));
  const atView = useMemo(() => new Set(key ? key.split(',') : []), [key]);
  const views = useMemo(() => all.filter((c) => c.anchor.camera), [all]);

  // ---- "jump to source": once the model is ready the camera goes to the comment's pose (not mid-drawing: it belongs to the view on screen) ----
  const jump = useAppSelector(selectJump);
  useEffect(() => {
    if (jump?.path !== path || jump.src !== src || !active || !ready || !viewer) return;
    dispatch(clearJump());
    const cam = all.find((c) => c.id === jump.id)?.anchor.camera;
    if (cam && !marking) viewer.setPose(cam);
  }, [jump, path, src, active, ready, viewer, all, marking, dispatch]);

  // ---- a drawing → a comment ----
  const { version, markPopup, setMarkPopup, closeMarkPopup, markAdded, saving, onPopupBusy } = useMarkPopup({ tabId, active, marking, mediaUrl: url });
  const onAdd = useCallback((shapes: MediaShape[], at: DOMRect) => {
    if (!viewer) return;
    const c = viewer.canvas;
    if (!c.width || !c.height) return toast(t('markNoSize'), path);
    const anchor: MediaAnchor = {
      kind: 'media', source: fileRef === undefined ? { kind: 'file', path } : { kind: 'file', path, ref: fileRef },
      width: c.width, height: c.height, camera: viewer.getPose(), shapes,
    };
    const id = crypto.randomUUID();
    const v = version.current;
    setMarkPopup({
      anchor, rect: at, id,
      prepare: async () => {
        // the frame is drawn from the canvas right now, so the pose is read from the very render the pixels come from
        const camera = viewer.renderNow();
        const [width, height] = [c.width, c.height];
        if (!width || !height) throw new Error(t('markNoSize'));
        const r = await prepareMediaComment(id, c, { ...anchor, width, height, camera }, { version: v });
        return { images: r.images, anchor: { ...r.anchor, width, height, camera } };
      },
    });
  }, [viewer, path, fileRef, t, version, setMarkPopup]);

  if (!canvas || !ready) return null;
  return (
    <>
      <MediaMarks tabId={tabId} media={canvas} fit="contain" path={path} refName={fileRef} atView={atView} />
      <MarkupLayer tabId={tabId} media={canvas} fit="contain" onAdd={onAdd} held={!!markPopup} saving={saving} />
      {views.length > 0 && !marking && (
        <div data-anchor-skip data-model-views role="group" aria-label={t('modelViews')} className="absolute bottom-9 left-3 z-10 flex max-h-24 max-w-[70%] flex-wrap gap-1 overflow-y-auto">
          {views.map((c, i) => {
            const stale = c.status === 'sent' || changedSince(c, current);
            const text = c.text.trim();
            return (
              <button
                key={c.id}
                type="button"
                data-view-chip={c.id}
                aria-pressed={atView.has(c.id)}
                title={`${t('modelViewGo')}${text ? `: ${text}` : ''}${changedSince(c, current) ? ` (${t('fileChanged')})` : ''}`}
                onClick={() => viewer?.setPose(c.anchor.camera!)}
                className={`rounded-full border border-border-soft bg-chrome/90 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur hover:text-foreground aria-pressed:border-nb-accent aria-pressed:text-nb-accent ${stale ? 'opacity-60' : ''}`}
              >
                {i + 1}{text ? ` · ${text.length > CHIP_CHARS ? `${text.slice(0, CHIP_CHARS)}…` : text}` : ''}
              </button>
            );
          })}
        </div>
      )}
      {markPopup && createPortal(
        <div className="relative z-30" hidden={!active}>
          <CommentPopup
            key={markPopup.id}
            pending={markPopup}
            onClose={closeMarkPopup}
            onAdded={() => markAdded(isMediaAnchor(markPopup.anchor) ? markPopup.anchor.shapes : [])}
            onBusy={onPopupBusy}
            hidden={!active}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
