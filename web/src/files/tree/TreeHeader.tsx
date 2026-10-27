import { useT } from '@/i18n/index.ts';
import { Svg } from '@/tabs/TabStrip.tsx';

type Props = {
  canReveal: boolean; onReveal: () => void;
  expanding: boolean; onExpandAll: () => void;
  onCollapseAll: () => void;
  spinning: boolean; onRefresh: () => void;
};

const btn = 'grid size-[26px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground';

/** The sheet's title bar: reveal opened, expand all, collapse all, refresh. */
export function TreeHeader({ canReveal, onReveal, expanding, onExpandAll, onCollapseAll, spinning, onRefresh }: Props) {
  const t = useT();
  return (
    <div className="flex h-10 flex-none items-center gap-0.5 border-b border-border-soft pr-2 pl-3.5 text-[13px] font-medium text-foreground">
      <span className="min-w-0 flex-1 truncate">{t('files')}</span>
      {/* IntelliJ's "Select Opened File": the active file tab's row, in that tab's source */}
      <button type="button" aria-label={t('revealOpened')} title={t('revealOpened')} disabled={!canReveal} onClick={onReveal}
        className={`${btn} disabled:opacity-40 disabled:hover:bg-transparent`}>
        <Svg><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>
      </button>
      {/* aria-disabled, not disabled: a disabled button would drop the keyboard focus to <body> */}
      <button type="button" aria-label={t('expandAll')} title={t('expandAll')} aria-disabled={expanding} onClick={onExpandAll}
        className={`${btn} aria-disabled:opacity-40`}>
        <Svg><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></Svg>
      </button>
      <button type="button" aria-label={t('collapseAll')} title={t('collapseAll')} onClick={onCollapseAll} className={btn}>
        <Svg><path d="m7 20 5-5 5 5M7 4l5 5 5-5" /></Svg>
      </button>
      <button type="button" aria-label={t('refresh')} title={t('refresh')} onClick={onRefresh} className={btn}>
        <span className={spinning ? 'animate-spin' : ''}>
          <Svg><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></Svg>
        </span>
      </button>
    </div>
  );
}
