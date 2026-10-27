import type { TreeEntry } from '@nota-bene/shared';
import { openFile } from '@/tabs/slice.ts';
import { Svg } from '@/tabs/TabStrip.tsx';
import { FileIcon } from '../FileIcon.tsx';
import { fileKey } from '../sources.ts';
import { join } from './useExpandAll.ts';

/** What the rows read: the listings, the open folders, the filter, the badges, the active file and the source. */
export type RowsCtx = {
  entries: Record<string, TreeEntry[]>; dirs: string[]; f: string; counts: Record<string, number>;
  activePath: string | null; src: string; ref: string | undefined;
  onToggle: (path: string) => void; onOpen: (a: { path: string; src: string; ref: string | undefined }) => void;
};

/** The rows of one folder (and, recursively, of its open subfolders). */
export function renderDir(c: RowsCtx, dir: string, depth: number): React.ReactNode {
  const { entries, dirs, f, counts, activePath, src, ref } = c;
  return (entries[dir] ?? []).map((e) => {
    const p = join(dir, e.name);
    const dot = e.name.startsWith('.') ? ' opacity-50' : '';
    const pad = { paddingLeft: 6 + depth * 12 };
    if (e.dir) {
      const isOpen = dirs.includes(p);
      return (
        <div key={p}>
          <button type="button" data-path={p} aria-expanded={isOpen} onClick={() => c.onToggle(p)} style={pad}
            className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs text-foreground/85 hover:bg-muted/50 hover:text-foreground${dot}`}>
            <Svg size={12}><path d="m9 6 6 6-6 6" className={isOpen ? 'origin-center rotate-90' : ''} style={{ transformBox: 'fill-box' }} /></Svg>
            <FileIcon dir open={isOpen} />
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
          </button>
          {isOpen && renderDir(c, p, depth + 1)}
        </div>
      );
    }
    if (f && !e.name.toLowerCase().includes(f)) return null;
    const n = counts[fileKey(p, ref)] ?? 0;
    return (
      <button key={p} type="button" data-path={p} onClick={() => c.onOpen({ path: p, src, ref })} style={pad}
        className={`flex h-6 w-full items-center gap-1.5 rounded pr-2 text-left text-xs hover:bg-muted/50 hover:text-foreground${dot} ${activePath === p ? 'bg-primary/15 text-foreground' : 'text-foreground/85'}`}>
        <span className="w-3 flex-none" />
        <FileIcon path={e.name} />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {n > 0 && <span data-badge className="rounded-full bg-nb-accent/[.18] px-1.5 text-[10px] font-semibold leading-4 text-nb-accent">{n}</span>}
      </button>
    );
  });
}
