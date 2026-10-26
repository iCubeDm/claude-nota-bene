import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useT } from '@/i18n/index.ts';
import { selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { fileTabId, openFile, selectTabs, type SavedFile } from '@/tabs/slice.ts';
import { FileIcon } from './FileIcon.tsx';
import { readRecent, recentModal } from './recent.ts';

const DEBOUNCE_MS = 120;
const SEARCH_MAX = 30;

const key = (f: SavedFile) => `${f.src ?? 'here'}:${f.path}`;
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * Cmd/Ctrl+E (M6-13, IntelliJ's Recent Files): the recently opened files of this root. An empty query lists them,
 * with the previous file selected (Enter flips back); a query filters them and searches the whole project through
 * `/complete` (files only, recent matches first). ↑↓ Enter Esc.
 */
export function RecentFiles() {
  const t = useT();
  const d = useAppDispatch();
  const open = useSyncExternalStore(recentModal.subscribe, recentModal.get);
  const root = useAppSelector((s) => selectSession(s)?.root ?? null);
  const active = useAppSelector((s) => selectTabs(s).active);
  const [q, setQ] = useState('');
  const [recent, setRecent] = useState<SavedFile[]>([]);
  const [found, setFound] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // read on open: the list changed with every tab switch since
  useEffect(() => {
    if (!open) return;
    const list = root ? readRecent(root) : [];
    setRecent(list);
    setQ('');
    setFound([]);
    // the current file is first: start on the one before it, so Enter goes back (IntelliJ)
    const cur = list.findIndex((f) => fileTabId(f.path, f.src) === active);
    setAt(cur === 0 && list.length > 1 ? 1 : 0);
    // `active` is read once per opening, not followed
  }, [open, root]);

  // Cmd/Ctrl+E; moves into the keymap module with M6-14
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        if (recentModal.get()) recentModal.close();
        else recentModal.open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const needle = q.trim().toLowerCase();
  useEffect(() => {
    if (!open || !needle) return void setFound([]);
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/complete?q=${encodeURIComponent(needle)}`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
        .then((hits) => setFound(hits.filter((p) => !p.endsWith('/'))), () => { /* aborted or offline: the recent matches stay */ });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [open, needle]);

  const mine = needle ? recent.filter((f) => f.path.toLowerCase().includes(needle)) : recent;
  const seen = new Set(mine.map(key));
  const items: SavedFile[] = [...mine, ...found.map((path) => ({ path })).filter((f) => !seen.has(key(f)))].slice(0, needle ? SEARCH_MAX : undefined);
  const cur = Math.max(0, Math.min(at, items.length - 1));

  const close = () => recentModal.close();
  const pick = (f: SavedFile | undefined) => {
    if (!f) return;
    close();
    d(openFile({ path: f.path, src: f.src ?? 'here', ...(f.ref && { ref: f.ref }) }));
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); input.current?.focus({ preventScroll: true }); }}
          className="fixed top-[14vh] left-1/2 z-50 flex max-h-[min(70vh,560px)] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl outline-none"
        >
          <DialogPrimitive.Title className="px-2 pt-1 pb-1.5 text-xs font-semibold text-muted-foreground">{t('recentTitle')}</DialogPrimitive.Title>
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setAt(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(items.length - 1, cur + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(0, cur - 1)); }
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); pick(items[cur]); }
            }}
            placeholder={t('recentFilter')}
            aria-label={t('recentFilter')}
            className="mx-1 mb-1 flex-none rounded-md border border-border-soft bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-primary"
          />
          <div role="listbox" aria-label={t('recentTitle')} className="min-h-0 overflow-auto">
            {!items.length && <div className="px-2 py-4 text-center text-xs text-muted-foreground">{needle ? t('recentNone') : t('recentEmpty')}</div>}
            {items.map((f, i) => (
              <button
                key={key(f)}
                type="button"
                role="option"
                aria-selected={i === cur}
                data-recent={f.path}
                onMouseMove={() => setAt(i)}
                onClick={() => pick(f)}
                ref={(el) => { if (i === cur) el?.scrollIntoView?.({ block: 'nearest' }); }}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] ${i === cur ? 'bg-muted text-foreground' : 'text-foreground/85'}`}
              >
                <FileIcon path={f.path} />
                <span className="truncate">{f.path.split('/').pop()}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-muted-foreground">{dirOf(f.path)}{f.ref ? ` @ ${f.ref}` : ''}</span>
              </button>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
