import { useRef, type MutableRefObject, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { isMediaAnchor } from '@nota-bene/shared';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { useT } from '@/i18n/index.ts';
import { applyPlayerKey, usePlayerKeys } from '@/media/playerKeys.ts';
import { PlayerBar } from '@/media/PlayerBar.tsx';
import { PlayerFlash } from '@/media/PlayerFlash.tsx';
import { MarkupLayer } from '@/media/markup/MarkupLayer.tsx';
import { MediaMarks } from '@/media/markup/MediaMarks.tsx';
import type { FileKind } from '../kinds.ts';
import type { MediaMarkup } from './useMediaMarkup.ts';

/** The pane of an image, video or audio file (or its "gone" note), with the markup layers over an image or video. */
export function MediaBody({ kind, path, fileRef, tabId, active, marking, natural, onToggleNatural, mediaUrl, failed, srcGone, onError, onMediaMeta, markup, mediaEl }: {
  kind: FileKind; path: string; fileRef: string | undefined; tabId: string; active: boolean; marking: boolean; natural: boolean;
  onToggleNatural: () => void; mediaUrl: string; failed: boolean; srcGone: boolean; onError: () => void;
  onMediaMeta: (e: SyntheticEvent<HTMLMediaElement>) => void; markup: MediaMarkup; mediaEl: MutableRefObject<HTMLMediaElement | null>;
}) {
  const t = useT();
  const { markable, player, mediaRef, imgRef, markPopup } = markup;
  // the player container: what F fullscreens, so the marks and the bar come along
  const box = useRef<HTMLDivElement>(null);
  const flash = usePlayerKeys({ tabId, active, marking, media: mediaEl, image: kind === 'image' ? markable as HTMLImageElement | null : null, box });
  const unit = t('unitSec');
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
        {/* no native controls (PlayerBar is ours); while marking up the bar is gone too: the frame stays still */}
        {kind === 'video' ? (
          <video
            ref={mediaRef} preload="metadata" src={mediaUrl} onError={onError} onLoadedMetadata={onMediaMeta} data-media-tab={tabId} className="nb-fit"
            // a click on a mark never gets here (the mark is another element and stops its own click)
            onClick={(e) => marking || applyPlayerKey(e.currentTarget, 'KeyK', unit)}
            onDoubleClick={(e) => marking || applyPlayerKey(e.currentTarget, 'KeyF', unit, box.current)}
          />
        ) : (
          <>
            <audio ref={mediaRef} preload="metadata" src={mediaUrl} onError={onError} onLoadedMetadata={onMediaMeta} data-media-tab={tabId} />
            {player && <PlayerBar media={player} box={box} tabId={tabId} path={path} refName={fileRef} flash={flash} />}
          </>
        )}
      </div>
    );
  }
  if (!((kind === 'image' || kind === 'video') && !failed && !srcGone)) {
    return kind === 'audio' && !failed && !srcGone ? <div ref={box} className="relative flex min-h-0 flex-1 flex-col">{body}<PlayerFlash flash={flash} /></div> : body;
  }
  const fit = kind === 'image' && natural ? 'natural' : 'contain';
  return (
    // the toolbar sits over the pane but outside its scroll, so it stays in the corner in natural size
    <div ref={box} className="relative flex min-h-0 flex-1 flex-col bg-background">
      {body}
      <PlayerFlash flash={flash} />
      {markable && <MediaMarks tabId={tabId} media={markable} fit={fit} path={path} refName={fileRef} />}
      {markable && <MarkupLayer tabId={tabId} media={markable} fit={fit} onAdd={markup.onMarkAdd} held={!!markPopup} saving={markup.saving} />}
      {kind === 'video' && player && !marking && <PlayerBar media={player} box={box} tabId={tabId} path={path} refName={fileRef} flash={flash} />}
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
