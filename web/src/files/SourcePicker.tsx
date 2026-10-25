import type { Source } from '@nota-bene/shared';
import { useT } from '@/i18n/index.ts';

/** The branch chip of a view or a tab of another source (M3-16): read-only. */
export function SourceChip({ name }: { name: string }) {
  const t = useT();
  return (
    <span data-src-chip title={t('readOnly')} className="max-w-[120px] flex-none truncate rounded bg-muted px-1 font-mono text-[10.5px] leading-4 text-muted-foreground">
      {name}
    </span>
  );
}

/** How a source reads in the picker: "this folder · main", "worktree · feature/x", "branch · old". */
export function sourceLabel(s: Source, t: ReturnType<typeof useT>): string {
  if (s.kind === 'checkout') return s.ref ? `${t('sourceHere')} · ${s.ref}` : t('sourceHere');
  return `${t(s.kind === 'worktree' ? 'sourceWorktree' : 'sourceBranch')} · ${s.label}`;
}

/**
 * The source picker at the top of the tree sheet: this folder, the other worktrees, the branches checked out nowhere.
 * A plain select (keyboard and screen readers for free); hidden when there is nothing but this folder.
 */
export function SourcePicker({ value, sources, onChange }: { value: string; sources: Source[]; onChange: (id: string) => void }) {
  const t = useT();
  if (sources.length < 2) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={t('sourcePick')}
      title={value === 'here' ? undefined : t('readOnly')}
      className="mx-2 mt-2.5 h-[30px] flex-none truncate rounded-lg border border-transparent bg-muted/50 px-2 text-[12.5px] text-foreground outline-0 focus:border-primary/50"
    >
      {sources.map((s) => (
        <option key={s.id} value={s.id}>{sourceLabel(s, t)}</option>
      ))}
    </select>
  );
}
