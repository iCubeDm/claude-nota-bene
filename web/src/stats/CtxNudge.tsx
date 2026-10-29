import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { runCommand, selectCapabilities, selectSwitching } from '@/controls/slice.ts';
import { REFUSED, useNote } from '@/controls/useNote.ts';
import { selectBusy, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { selectStats } from './slice.ts';

/** The context fill levels that bring up the reminder, in percent. */
export const NUDGE_STEPS = [25, 50, 75] as const;

/** The highest step the context has reached (0 below the first). */
export const nudgeStep = (pct: number): number => NUDGE_STEPS.reduce((top, s) => (pct >= s ? s : top), 0);

const KEY = 'nb.ctxNudge';

/** A test flag: `?nudge` in the page's URL shows the button at any fill (the real %, the agent still idle); × hides it until a reload. */
export const nudgeForced = (): boolean => new URLSearchParams(location.search).has('nudge');

/** The step dismissed per session: { [sessionId]: step }. */
function readSeen(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeSeen(id: string, step: number) {
  // only the latest few sessions: the map would otherwise grow with every session ever opened
  const all = Object.entries({ ...readSeen(), [id]: step }).slice(-20);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(all))); } catch { /* storage unavailable: not persisted */ }
}

/**
 * A blinking "Compact" button above the input once the context reaches 25, 50 or 75 %, while the agent is idle.
 * × hides it until the next step; a compaction (or any drop below a step) lowers the seen step, so the climb after it
 * reminds again.
 */
export function CtxNudge() {
  const t = useT();
  // null until the session's first stats: a 0 then must not count as "the context went down"
  const pct = useAppSelector(selectStats)?.context?.pct ?? null;
  const id = useAppSelector(selectSession)?.id ?? null;
  const idle = useAppSelector((s) => !selectBusy(s) && !selectSwitching(s) && s.feed.compacting == null);
  const canCompact = useAppSelector(selectCapabilities).compact;
  const step = pct == null ? null : nudgeStep(pct);
  const [seen, setSeen] = useState(() => (id ? readSeen()[id] ?? 0 : 0));
  const [forced, setForced] = useState(nudgeForced);
  useEffect(() => setSeen(id ? readSeen()[id] ?? 0 : 0), [id]);
  // the context went down (a compaction, a /clear): what was dismissed above it no longer holds
  useEffect(() => {
    if (id && step != null && seen > step) {
      setSeen(step);
      writeSeen(id, step);
    }
  }, [id, seen, step]);
  if (forced && canCompact && idle) {
    const p = Math.round(pct ?? 0);
    return <Nudge label={t('ctxNudge', p)} hot={p >= 75} onDismiss={() => setForced(false)} />;
  }
  if (!id || step == null || !canCompact || !idle || step <= seen) return null;
  return (
    <Nudge
      label={t('ctxNudge', step)}
      hot={step >= 75}
      onDismiss={() => {
        setSeen(step);
        writeSeen(id, step);
      }}
    />
  );
}

function Nudge({ label, hot, onDismiss }: { label: string; hot: boolean; onDismiss: () => void }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const [note, showNote] = useNote();
  if (note) return <span role="status" className="text-warn">{note}</span>;
  return (
    <span data-testid="ctx-nudge" className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          const r = dispatch(runCommand('compact'));
          if (r !== 'sent') showNote(t(REFUSED[r]));
        }}
        title={t('compactTip')}
        className={`nb-blink rounded-full border px-2.5 py-0.5 font-medium ${hot ? 'border-destructive/60 bg-destructive/15 text-destructive [--nb-blink:var(--destructive)]' : 'border-nb-accent/60 bg-nb-accent/15 text-nb-accent [--nb-blink:var(--nb-accent)]'}`}
      >
        {label}
      </button>
      <button type="button" aria-label={t('ctxNudgeLater')} title={t('ctxNudgeLater')} onClick={onDismiss} className="rounded px-1 text-muted-foreground hover:text-foreground">
        ×
      </button>
    </span>
  );
}
