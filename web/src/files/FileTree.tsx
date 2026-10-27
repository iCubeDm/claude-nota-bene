import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectPendingCountByPath } from '@/comments/slice.ts';
import { selectActiveTab, openFile } from '@/tabs/slice.ts';
import { clearReveal, pickSource, revealFile, selectTree, setDirs, setTreeOpen, toggleDir } from '@/tree/slice.ts';
import { selectTurnSeq, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { loadSources, useSources } from './sources.ts';
import { SourcePicker } from './SourcePicker.tsx';
import { PanelResizer, usePanelWidth } from '@/shell/PanelResizer.tsx';
import { useTreeEntries } from './tree/useTreeEntries.ts';
import { useExpandAll } from './tree/useExpandAll.ts';
import { TreeHeader } from './tree/TreeHeader.tsx';
import { renderDir } from './tree/TreeRow.tsx';

export { EXPAND_CAP } from './tree/useExpandAll.ts';

const TREE_MIN = 200;

/** The left tool window, docked next to its strip: open, it narrows the middle column (R-M6-3). */
export function FileTree() {
  const t = useT();
  const d = useAppDispatch();
  const { open, dirs, reveal, src } = useAppSelector(selectTree);
  const turnSeq = useAppSelector(selectTurnSeq);
  const counts = useAppSelector(selectPendingCountByPath);
  const active = useAppSelector(selectActiveTab);
  const activePath = active.kind === 'file' && active.src === src ? active.path : null;
  const sources = useSources();
  const source = sources.find((x) => x.id === src);
  const ref = src === 'here' ? undefined : source?.ref;

  const [filter, setFilter] = useState('');
  const size = usePanelWidth('panel:tree:width', 300, TREE_MIN);
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  // a closing sheet becomes `hidden`: do not leave focus inside it, hand it to the header toggle (as the comments panel
  // does). A layout effect: it runs before the browser drops the focus of a now-hidden element to <body>
  useLayoutEffect(() => {
    if (!open && sheet.current?.contains(document.activeElement)) document.getElementById('toggleTree')?.focus();
  }, [open]);
  // "Expand all" in progress: the state lives here because both hooks read it (the entries skip a refresh during a run)
  const [expanding, setExpanding] = useState(false);
  const tree = useTreeEntries({ open, dirs, src, sources, turnSeq, run: { running: expanding, stop: () => setExpanding(false) } });
  const { entries, failed, loading, refresh } = tree;
  const expandAll = useExpandAll({ tree, open, dirs, src, running: expanding, setRunning: setExpanding });

  // the picker's list: fetched when the sheet opens (cached 5 s); a source that vanished falls back to this folder
  useEffect(() => {
    if (open) void loadSources();
  }, [open]);
  useEffect(() => {
    if (!source && sources.length > 0 && src !== 'here' && sources.some((x) => x.id !== 'here')) d(pickSource('here'));
  }, [source, sources, src, d]);

  // a reveal clears the filter, so the revealed row is not filtered away
  useEffect(() => {
    if (reveal) setFilter('');
  }, [reveal]);

  // reveal: scroll to the row once its folder is loaded, then clear the request
  useEffect(() => {
    if (!reveal || !open) return;
    const el = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find((n) => n.dataset.path === reveal);
    if (!el) return;
    el.scrollIntoView?.({ block: 'nearest' });
    d(clearReveal());
  }, [reveal, open, entries, d]);

  const rows = {
    entries, dirs, f: filter.trim().toLowerCase(), counts, activePath, src, ref,
    onToggle: (p: string) => { setExpanding(false); d(toggleDir(p)); },
    onOpen: (a: { path: string; src: string; ref: string | undefined }) => d(openFile(a)),
  };

  return (
    <aside
      ref={sheet}
      id="tree-sheet"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); d(setTreeOpen(false)); }
      }}
      style={{ width: size.width, maxWidth: '45vw' }}
      className="relative flex flex-none flex-col border-r border-border-soft bg-chrome"
    >
      <PanelResizer edge="right" width={size.width} onWidth={size.set} onReset={size.reset} min={TREE_MIN} label={t('resizeFiles')} />
      <TreeHeader
        canReveal={active.kind === 'file'}
        onReveal={() => { if (active.kind === 'file') d(revealFile(active.path, active.src)); }}
        expanding={expanding} onExpandAll={expandAll.start}
        onCollapseAll={() => { setExpanding(false); d(setDirs([])); }}
        spinning={loading > 0} onRefresh={() => { void refresh(); void loadSources(true); }}
      />
      <SourcePicker value={src} sources={sources} onChange={(id) => d(pickSource(id))} />
      <input type="search" role="searchbox" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('filterPh')} aria-label={t('filterPh')}
        className="mx-2 mt-2.5 mb-1.5 h-[30px] flex-none rounded-lg border border-transparent bg-muted/50 px-2.5 text-[12.5px] text-foreground outline-0 focus:border-primary/50" />
      {failed && <div role="alert" className="mx-2 mb-1 text-xs text-warn">{t('serverError', '/tree')}</div>}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-1.5 pt-0.5 pb-3">{renderDir(rows, '', 0)}</div>
    </aside>
  );
}
