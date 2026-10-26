import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TreeEntry } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { selectPendingCountByPath } from '@/comments/slice.ts';
import { selectActiveTab, openFile } from '@/tabs/slice.ts';
import { Svg } from '@/tabs/TabStrip.tsx';
import { FileIcon } from './FileIcon.tsx';
import { clearReveal, pickSource, revealFile, selectTree, setDirs, setTreeOpen, toggleDir } from '@/tree/slice.ts';
import { selectTurnSeq, useAppDispatch, useAppSelector, type RootState } from '@/store/store.ts';
import { useStore } from 'react-redux';
import { fileKey, isFixed, loadSources, useSources } from './sources.ts';
import { SourcePicker } from './SourcePicker.tsx';
import { PanelResizer, usePanelWidth } from '@/shell/PanelResizer.tsx';

type Loaded = TreeEntry[] | 'gone' | 'error';

/** Always build the query with encodeURIComponent: a `+` in a name must survive. */
async function loadDir(rel: string, src: string): Promise<Loaded> {
  try {
    const r = await fetch(`/tree?path=${encodeURIComponent(rel)}${src === 'here' ? '' : `&src=${encodeURIComponent(src)}`}`);
    if (r.status === 404) return 'gone';
    if (!r.ok) return 'error';
    return (await r.json()) as TreeEntry[];
  } catch {
    return 'error';
  }
}

const TREE_MIN = 200;
/** "Expand all" stops once the tree shows this many rows (a huge folder never freezes the sheet). */
export const EXPAND_CAP = 2000;
/** Never opened by "Expand all": dependency and VCS folders would eat the cap before the project's own (a click still opens them). */
const NO_EXPAND = new Set(['node_modules', '.git']);

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The left tool window, docked next to its strip: open, it narrows the middle column (R-M6-3). */
export function FileTree() {
  const t = useT();
  const d = useAppDispatch();
  const store = useStore<RootState>();
  const { open, dirs, reveal, src } = useAppSelector(selectTree);
  const turnSeq = useAppSelector(selectTurnSeq);
  const counts = useAppSelector(selectPendingCountByPath);
  const active = useAppSelector(selectActiveTab);
  const activePath = active.kind === 'file' && active.src === src ? active.path : null;
  const sources = useSources();
  const source = sources.find((x) => x.id === src);
  const ref = src === 'here' ? undefined : source?.ref;

  const [entries, setEntries] = useState<Record<string, TreeEntry[]>>({});
  const [filter, setFilter] = useState('');
  const size = usePanelWidth('panel:tree:width', 300, TREE_MIN);
  const [loading, setLoading] = useState(0);
  const [failed, setFailed] = useState(false);
  const requested = useRef(new Set<string>());
  const busy = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  // a closing sheet becomes `hidden`: do not leave focus inside it, hand it to the header toggle (as the comments panel
  // does). A layout effect: it runs before the browser drops the focus of a now-hidden element to <body>
  useLayoutEffect(() => {
    if (!open && sheet.current?.contains(document.activeElement)) document.getElementById('toggleTree')?.focus();
  }, [open]);
  // the source the loaded entries belong to: a switch drops them, and an answer for the previous source is ignored
  const shown = useRef(src);
  // "Expand all" in progress: each loaded level opens the next, until EXPAND_CAP rows or nothing is left
  const [expanding, setExpanding] = useState(false);
  if (shown.current !== src) {
    shown.current = src;
    requested.current = new Set();
    if (expanding) setExpanding(false);
  }
  useEffect(() => setEntries({}), [src]);

  // the picker's list: fetched when the sheet opens (cached 5 s); a source that vanished falls back to this folder
  useEffect(() => {
    if (open) void loadSources();
  }, [open]);
  useEffect(() => {
    if (!source && sources.length > 0 && src !== 'here' && sources.some((x) => x.id !== 'here')) d(pickSource('here'));
  }, [source, sources, src, d]);

  const track = useCallback(async <T,>(p: Promise<T>): Promise<T> => {
    setLoading((n) => n + 1);
    try { return await p; } finally { setLoading((n) => n - 1); }
  }, []);

  // Lazy expand: any folder in `dirs` (clicked, restored, revealed) is fetched once.
  useEffect(() => {
    if (!open) return;
    const want = ['', ...dirs].filter((p) => !requested.current.has(p));
    for (const p of want) {
      requested.current.add(p);
      void track(loadDir(p, src)).then((r) => {
        if (shown.current !== src) return;
        if (r === 'error') { requested.current.delete(p); setFailed(true); return; }
        setEntries((e) => ({ ...e, [p]: r === 'gone' ? [] : r }));
      });
    }
  }, [open, dirs, src, track]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const paths = ['', ...dirs];
      // the root it was asked for: an answer that lands after a switch to another root (same 'here' source, other
      // folder) must not prune that root's folders with this one's listing
      const gen = store.getState().tabs.rootGen;
      const results = await track(Promise.all(paths.map((p) => loadDir(p, src))));
      if (shown.current !== src || store.getState().tabs.rootGen !== gen) return;
      const next: Record<string, TreeEntry[]> = {};
      const keep: string[] = [];
      let bad = false;
      paths.forEach((p, i) => {
        const r = results[i];
        if (r === 'error') { bad = true; keep.push(p); return; }
        if (r === 'gone') { if (p === '') next[p] = []; return; } // a vanished folder is dropped silently
        next[p] = r;
        if (p) keep.push(p);
      });
      setFailed(bad);
      setEntries((e) => {
        for (const p of paths) if (results[paths.indexOf(p)] === 'error' && e[p]) next[p] = e[p];
        return next;
      });
      const kept = new Set(keep);
      requested.current = new Set(['', ...keep]);
      if (kept.size !== dirs.length) d(setDirs(dirs.filter((p) => kept.has(p))));
    } finally {
      busy.current = false;
    }
  }, [dirs, src, d, track, store]);

  // refresh after every live turn (replay does not move turnSeq); the first value is not a change. A branch only
  // changes with a commit: no refresh for it
  const seenTurn = useRef(turnSeq);
  useEffect(() => {
    if (seenTurn.current === turnSeq) return;
    seenTurn.current = turnSeq;
    if (!isFixed(src, sources) && (open || requested.current.size > 0)) void refresh();
  }, [turnSeq, open, src, sources, refresh]);

  // "Expand all": once every open folder is loaded, open the closed folders it shows, one level per round. Stops at the
  // cap, when no closed folder is left, or on a load error (that folder would never load and stall the rounds)
  useEffect(() => {
    if (!expanding) return;
    if (failed || !open) return void setExpanding(false);
    if (['', ...dirs].some((p) => !entries[p])) return; // this level is still loading
    const open_ = new Set(dirs);
    const closed: string[] = [];
    let rows = 0;
    const walk = (dir: string) => {
      for (const e of entries[dir] ?? []) {
        rows++;
        const p = join(dir, e.name);
        if (!e.dir) continue;
        if (open_.has(p)) walk(p);
        else if (!NO_EXPAND.has(e.name)) closed.push(p);
      }
    };
    walk('');
    if (rows >= EXPAND_CAP || !closed.length) return void setExpanding(false);
    d(setDirs([...dirs, ...closed]));
  }, [expanding, entries, dirs, failed, open, d]);

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

  const f = filter.trim().toLowerCase();
  const renderDir = (dir: string, depth: number): React.ReactNode =>
    (entries[dir] ?? []).map((e) => {
      const p = join(dir, e.name);
      const dot = e.name.startsWith('.') ? ' opacity-50' : '';
      const pad = { paddingLeft: 6 + depth * 12 };
      if (e.dir) {
        const isOpen = dirs.includes(p);
        return (
          <div key={p}>
            <button type="button" data-path={p} aria-expanded={isOpen} onClick={() => { setExpanding(false); d(toggleDir(p)); }} style={pad}
              className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs text-foreground/85 hover:bg-muted/50 hover:text-foreground${dot}`}>
              <Svg size={12}><path d="m9 6 6 6-6 6" className={isOpen ? 'origin-center rotate-90' : ''} style={{ transformBox: 'fill-box' }} /></Svg>
              <FileIcon dir open={isOpen} />
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
            </button>
            {isOpen && renderDir(p, depth + 1)}
          </div>
        );
      }
      if (f && !e.name.toLowerCase().includes(f)) return null;
      const n = counts[fileKey(p, ref)] ?? 0;
      return (
        <button key={p} type="button" data-path={p} onClick={() => d(openFile({ path: p, src, ref }))} style={pad}
          className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs hover:bg-muted/50 hover:text-foreground${dot} ${activePath === p ? 'bg-primary/15 text-foreground' : 'text-foreground/85'}`}>
          <span className="w-3 flex-none" />
          <FileIcon path={e.name} />
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {n > 0 && <span data-badge className="rounded-full bg-nb-accent/[.18] px-1.5 text-[10px] font-semibold leading-4 text-nb-accent">{n}</span>}
        </button>
      );
    });

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
      <div className="flex h-10 flex-none items-center gap-0.5 border-b border-border-soft pr-2 pl-3.5 text-[13px] font-medium text-foreground">
        <span className="min-w-0 flex-1 truncate">{t('files')}</span>
        {/* IntelliJ's "Select Opened File": the active file tab's row, in that tab's source */}
        <button type="button" aria-label={t('revealOpened')} title={t('revealOpened')} disabled={active.kind !== 'file'}
          onClick={() => { if (active.kind === 'file') d(revealFile(active.path, active.src)); }}
          className="grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent">
          <Svg><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>
        </button>
        <button type="button" aria-label={t('expandAll')} title={t('expandAll')} disabled={expanding} onClick={() => setExpanding(true)}
          className="grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
          <Svg><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></Svg>
        </button>
        <button type="button" aria-label={t('collapseAll')} title={t('collapseAll')} onClick={() => { setExpanding(false); d(setDirs([])); }}
          className="grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
          <Svg><path d="m7 20 5-5 5 5M7 4l5 5 5-5" /></Svg>
        </button>
        <button type="button" aria-label={t('refresh')} title={t('refresh')} onClick={() => { void refresh(); void loadSources(true); }}
          className="grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
          <span className={loading > 0 ? 'animate-spin' : ''}>
            <Svg><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></Svg>
          </span>
        </button>
      </div>
      <SourcePicker value={src} sources={sources} onChange={(id) => d(pickSource(id))} />
      <input type="search" role="searchbox" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('filterPh')} aria-label={t('filterPh')}
        className="mx-2 mt-2.5 mb-1.5 h-[30px] flex-none rounded-lg border border-transparent bg-muted/50 px-2.5 text-[12.5px] text-foreground outline-0 focus:border-primary/50" />
      {failed && <div role="alert" className="mx-2 mb-1 text-xs text-warn">{t('serverError', '/tree')}</div>}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-1.5 pt-0.5 pb-3">{renderDir('', 0)}</div>
    </aside>
  );
}
