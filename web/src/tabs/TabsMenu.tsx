import { useRef, useState, type RefObject } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { useT } from '@/i18n/index.ts';
import { selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { activate, selectTabs, type Tab } from './slice.ts';
import { Svg, TabIcon, focusTab } from './TabStrip.tsx';

/** The ids of the tabs not fully inside the strip's visible width (a 1 px slack for subpixel layouts). */
export function hiddenTabs(strip: HTMLElement): Set<string> {
  const box = strip.getBoundingClientRect();
  const out = new Set<string>();
  for (const el of strip.querySelectorAll<HTMLElement>('[data-tab]')) {
    const r = el.getBoundingClientRect();
    if (r.left < box.left - 1 || r.right > box.right + 1) out.add(el.dataset.tab!);
  }
  return out;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * "▾" at the strip's right end (M6-12, IntelliJ): the hidden tabs first, then every tab, with a filter by path.
 * ↑↓ move, Enter opens, Esc closes. The hidden set is read from the layout when the menu opens.
 */
export function TabsMenu({ strip }: { strip: RefObject<HTMLElement | null> }) {
  const t = useT();
  const d = useAppDispatch();
  const { open: tabs, active } = useAppSelector(selectTabs);
  const title = useAppSelector((s) => selectSession(s)?.title ?? null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const label = (tab: Tab) => (tab.kind === 'chat' ? title || t('chat') : tab.kind === 'settings' ? t('settings') : tab.kind === 'diagram' ? tab.title || t('diagramTab') : tab.kind === 'agent' ? tab.title || t('agentTab') : tab.path.split('/').pop() || tab.path);
  const needle = q.trim().toLowerCase();
  const match = (tab: Tab) => !needle || (tab.kind === 'file' ? tab.path : label(tab)).toLowerCase().includes(needle);
  // no query: the hidden ones, then all; a query: every match once
  const sections: { name: string; items: Tab[] }[] = needle
    ? [{ name: '', items: tabs.filter(match) }]
    : [{ name: t('tabsHidden'), items: tabs.filter((x) => hidden.has(x.id)) }, { name: t('tabsAll'), items: tabs }].filter((s) => s.items.length);
  const flat = sections.flatMap((s) => s.items);
  const cur = Math.min(at, flat.length - 1);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) return;
    setQ('');
    setAt(0);
    setHidden(strip.current ? hiddenTabs(strip.current) : new Set());
  };
  const picked = useRef<string | null>(null);
  const pick = (tab: Tab | undefined) => {
    if (!tab) return;
    picked.current = tab.id;
    setOpen(false);
    d(activate(tab.id));
  };

  let n = -1;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button ref={trigger} type="button" aria-label={t('tabsAll')} title={t('tabsAll')}
          className="grid size-7 flex-none place-items-center rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground">
          <Svg><path d="m6 9 6 6 6-6" /></Svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label={t('tabsAll')}
        collisionPadding={8}
        className="flex max-h-[min(70vh,520px)] w-[380px] flex-col"
        onOpenAutoFocus={(e) => { e.preventDefault(); picked.current = null; requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); }}
        onCloseAutoFocus={(e) => { if (picked.current) { e.preventDefault(); focusTab(picked.current); } }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(flat.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); pick(flat[cur]); }
          }}
          placeholder={t('tabsFilter')}
          aria-label={t('tabsFilter')}
          role="combobox"
          aria-expanded
          aria-controls="nb-tabs-list"
          aria-activedescendant={flat.length ? `nb-tabs-opt-${cur}` : undefined}
          className="m-1 flex-none rounded-md border border-border-soft bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
        />
        <div id="nb-tabs-list" role="listbox" aria-label={t('tabsAll')} className="min-h-0 overflow-auto">
          {!flat.length && <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('tabsNone')}</div>}
          {sections.map((s) => (
            <div key={s.name || 'all'}>
              {s.name && <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">{s.name}</div>}
              {s.items.map((tab) => {
                const i = ++n;
                return (
                  <button
                    key={`${s.name}:${tab.id}`}
                    type="button"
                    role="option"
                    id={`nb-tabs-opt-${i}`}
                    tabIndex={-1}
                    aria-selected={i === cur}
                    data-tab-item={tab.id}
                    onMouseMove={() => setAt(i)}
                    onClick={() => pick(tab)}
                    ref={(el) => { if (i === cur) el?.scrollIntoView?.({ block: 'nearest' }); }}
                    className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs ${i === cur ? 'bg-muted text-foreground' : 'text-foreground/85'}`}
                  >
                    <TabIcon tab={tab} />
                    <span className={`truncate ${tab.id === active ? 'font-semibold text-primary' : ''}`}>{label(tab)}</span>
                    {tab.kind === 'diagram' && <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-muted-foreground">{t('diagramTab')}</span>}
                    {tab.kind === 'agent' && <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-muted-foreground">{t('agentTab')}</span>}
                    {tab.kind === 'file' && <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-muted-foreground">{dirOf(tab.path)}{tab.ref ? ` @ ${tab.ref}` : ''}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
