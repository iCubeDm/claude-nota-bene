import type { SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { isMediaAnchor } from '@nota-bene/shared';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { useT } from '@/i18n/index.ts';
import { MarkupLayer } from '@/media/markup/MarkupLayer.tsx';
import { MediaMarks } from '@/media/markup/MediaMarks.tsx';
import type { FileKind } from '../kinds.ts';
import type { MediaMarkup } from './useMediaMarkup.ts';

/** The pane of an image, video or audio file (or its "gone" note), with the markup layers over an image or video. */
export function MediaBody({ kind, path, fileRef, tabId, active, marking, natural, onToggleNatural, mediaUrl, failed, srcGone, onError, onMediaMeta, markup }: {
  kind: FileKind; path: string; fileRef: string | undefined; tabId: string; active: boolean; marking: boolean; natural: boolean;
  onToggleNatural: () => void; mediaUrl: string; failed: boolean; srcGone: boolean; onError: () => void;
  onMediaMeta: (e: SyntheticEvent<HTMLMediaElement>) => void; markup: MediaMarkup;
}) {
  const t = useT();
  const { markable, mediaRef, imgRef, markPopup } = markup;
  let body;
  if (failed || srcGone) {
    body = (
      <div data-pane={tabId} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
        {srcGone
          ? <p data-source-gone className="p-4 text-sm text-muted-foreground">{t('sourceGone')}</p>
          : <p className="p-4 text-sm text-muted-foreground">{t('fileGone')}</p>}
      </div>
    );
  } else if (kind === 'image') {
    body = (
      // M3-13 relies on data-pane as the pane's scroll container; data-file-path (text/md only) marks the text root
      <div data-pane={tabId} hidden={!active} className={`grid-pane nb-media-pane relative min-h-0 flex-1 overflow-auto${natural ? ' nb-natural' : ''}`}>
        <img
          ref={imgRef}
          src={mediaUrl}
          alt={path}
          onError={onError}
          onClick={() => marking || onToggleNatural()}
          className={`nb-fit ${marking ? '' : natural ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}
        />
      </div>
    );
  } else {
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
  }
  if (!((kind === 'image' || kind === 'video') && !failed && !srcGone)) return body;
  const fit = kind === 'image' && natural ? 'natural' : 'contain';
  return (
    // the toolbar sits over the pane but outside its scroll, so it stays in the corner in natural size
    <div className="relative flex min-h-0 flex-1 flex-col">
      {body}
      {markable && <MediaMarks tabId={tabId} media={markable} fit={fit} path={path} refName={fileRef} />}
      {markable && <MarkupLayer tabId={tabId} media={markable} fit={fit} onAdd={markup.onMarkAdd} held={!!markPopup} saving={markup.saving} />}
      {/* portalled with its own layer: above the markup toolbar, which it may open next to */}
      {markPopup && createPortal(
        <div className="relative z-30" hidden={!active}>
          {/* keyed: a new drawing's popup is a new popup, never the old one (and its save) re-rendered */}
          <CommentPopup
            key={markPopup.id}
            pending={markPopup}
            onClose={markup.closeMarkPopup}
            onAdded={() => markup.markAdded(isMediaAnchor(markPopup.anchor) ? markPopup.anchor.shapes : [])}
            onBusy={markup.onPopupBusy}
            hidden={!active}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
