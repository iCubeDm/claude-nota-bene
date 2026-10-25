import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeEntry } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';
import { selectPendingCountByPath } from '@/comments/slice.ts';
import { selectActiveTab, openFile } from '@/tabs/slice.ts';
import { ICONS, Svg, iconForPath } from '@/tabs/TabStrip.tsx';
import { clearReveal, selectTree, setDirs, setTreeOpen, toggleDir } from '@/tree/slice.ts';
import { selectTurnSeq, useAppDispatch, useAppSelector } from '@/store/store.ts';

type Loaded = TreeEntry[] | 'gone' | 'error';

/** Always build the query with encodeURIComponent: a `+` in a name must survive. */
async function loadDir(rel: string): Promise<Loaded> {
  try {
    const r = await fetch(`/tree?path=${encodeURIComponent(rel)}`);
    if (r.status === 404) return 'gone';
    if (!r.ok) return 'error';
    return (await r.json()) as TreeEntry[];
  } catch {
    return 'error';
  }
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** The left overlay sheet. It floats over the chat area (absolute), so it never shifts the chat layout. */
export function FileTree() {
  const t = useT();
  const d = useAppDispatch();
  const { open, dirs, reveal } = useAppSelector(selectTree);
  const turnSeq = useAppSelector(selectTurnSeq);
  const counts = useAppSelector(selectPendingCountByPath);
  const active = useAppSelector(selectActiveTab);
  const activePath = active.kind === 'file' ? active.path : null;

  const [entries, setEntries] = useState<Record<string, TreeEntry[]>>({});
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(0);
  const [failed, setFailed] = useState(false);
  const requested = useRef(new Set<string>());
  const busy = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

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
      void track(loadDir(p)).then((r) => {
        if (r === 'error') { requested.current.delete(p); setFailed(true); return; }
        setEntries((e) => ({ ...e, [p]: r === 'gone' ? [] : r }));
      });
    }
  }, [open, dirs, track]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const paths = ['', ...dirs];
      const results = await track(Promise.all(paths.map(loadDir)));
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
  }, [dirs, d, track]);

  // refresh after every live turn (replay does not move turnSeq); the first value is not a change
  const seenTurn = useRef(turnSeq);
  useEffect(() => {
    if (seenTurn.current === turnSeq) return;
    seenTurn.current = turnSeq;
    if (open || requested.current.size > 0) void refresh();
  }, [turnSeq, open, refresh]);

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
            <button type="button" data-path={p} aria-expanded={isOpen} onClick={() => d(toggleDir(p))} style={pad}
              className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs text-foreground/85 hover:bg-muted/50 hover:text-foreground${dot}`}>
              <Svg size={12}><path d="m9 6 6 6-6 6" className={isOpen ? 'origin-center rotate-90' : ''} style={{ transformBox: 'fill-box' }} /></Svg>
              <Svg>{ICONS.dir}</Svg>
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
            </button>
            {isOpen && renderDir(p, depth + 1)}
          </div>
        );
      }
      if (f && !e.name.toLowerCase().includes(f)) return null;
      const n = counts[p] ?? 0;
      return (
        <button key={p} type="button" data-path={p} onClick={() => d(openFile(p))} style={pad}
          className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs hover:bg-muted/50 hover:text-foreground${dot} ${activePath === p ? 'bg-primary/15 text-foreground' : 'text-foreground/85'}`}>
          <span className="w-3 flex-none" />
          <Svg>{iconForPath(e.name)}</Svg>
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {n > 0 && <span data-badge className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">{n}</span>}
        </button>
      );
    });

  return (
    <aside
      id="tree-sheet"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); d(setTreeOpen(false)); }
      }}
      className="absolute inset-y-0 left-0 z-[5] flex w-[300px] flex-col border-r border-border-soft bg-chrome backdrop-blur-[24px]"
    >
      <div className="flex h-10 flex-none items-center justify-between border-b border-border-soft pr-2 pl-3.5 text-[13px] font-medium text-foreground">
        {t('files')}
        <button type="button" aria-label={t('refresh')} title={t('refresh')} onClick={() => void refresh()}
          className="grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground">
          <span className={loading > 0 ? 'animate-spin' : ''}>
            <Svg><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></Svg>
          </span>
        </button>
      </div>
      <input type="search" role="searchbox" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('filterPh')} aria-label={t('filterPh')}
        className="mx-2 mt-2.5 mb-1.5 h-[30px] flex-none rounded-lg border border-transparent bg-muted/50 px-2.5 text-[12.5px] text-foreground outline-0 focus:border-primary/50" />
      {failed && <div role="alert" className="mx-2 mb-1 text-xs text-warn">{t('serverError', '/tree')}</div>}
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-1.5 pt-0.5 pb-3">{renderDir('', 0)}</div>
    </aside>
  );
}
