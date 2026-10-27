import type { Ref } from 'react';
import { Markdown } from '@/feed/Markdown.tsx';
import { HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { refClick } from '@/refs/refs.ts';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch } from '@/store/store.ts';
import type { FileKind } from '../kinds.ts';
import { CodeText } from './CodeText.tsx';
import type { Loaded } from './useFileLoad.ts';

/** The pane of a text or markdown file: the text, or a note (too big, binary, gone, an error). */
export function TextBody({ data, kind, path, src, fileRef, tabId, active, url, paneRef }: {
  data: Loaded | null; kind: FileKind; path: string; src: string; fileRef: string | undefined; tabId: string; active: boolean; url: string;
  paneRef: Ref<HTMLDivElement>;
}) {
  const t = useT();
  const dispatch = useAppDispatch();
  const note = (key: 'tooLarge' | 'binary' | 'fileGone') => (
    <p className="p-4 text-sm text-muted-foreground">
      {t(key)}
      {key !== 'fileGone' && (
        <> · <a href={url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{t('openRaw')}</a></>
      )}
    </p>
  );
  const goneSrc = <p data-source-gone className="p-4 text-sm text-muted-foreground">{t('sourceGone')}</p>;
  const inner =
    data == null ? null
    : data.s === 'text' ? (
      kind === 'md' ? <div className="nb-card nb-prose px-10 pt-5 pb-7" onClick={(e) => refClick(e, dispatch, src)}><Markdown text={data.text} final src={src} baseDir={path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined} /></div>
      : <pre className="nb-card nb-code overflow-x-auto p-4 font-mono text-xs leading-relaxed whitespace-pre"><CodeText text={data.text} path={path} /></pre>
    )
    : data.s === 'error' ? <p className="p-4 text-sm text-destructive">{data.message}</p>
    : data.s === 'sourceGone' ? goneSrc
    : note(data.s === 'gone' ? 'fileGone' : data.s);
  return (
    // data-file-path only while the text is shown: a note or an error is not commentable and has no anchors
    <div ref={paneRef} data-pane={tabId} data-file-path={data?.s === 'text' ? path : undefined} data-file-ref={fileRef} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
      {inner}
      <HighlightLayer pane={tabId} />
    </div>
  );
}
