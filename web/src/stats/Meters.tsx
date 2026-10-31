import type { Limit } from '@nota-bene/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { fmtK } from '@/lib/format.ts';
import { getLang, useT } from '@/i18n/index.ts';
import { selectCapabilitiesKnown } from '@/controls/slice.ts';
import { useAppSelector } from '@/store/store.ts';
import { selectStats } from './slice.ts';

export type Level = '' | 'warn' | 'hot';
export const meterLevel = (pct: number): Level => (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : '');

const FILL: Record<Level, string> = { '': 'bg-primary', warn: 'bg-nb-accent', hot: 'bg-destructive' };

function Meter({ label, pct, tip }: { label: string; pct: number; tip: string }) {
  const level = meterLevel(pct);
  const shown = Math.round(pct);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="meter"
          tabIndex={0}
          aria-label={`${label} ${shown}%`}
          aria-valuenow={shown}
          aria-valuemin={0}
          aria-valuemax={100}
          data-level={level || undefined}
          className={`meter ${level} inline-flex cursor-default items-center gap-1.5 ${level === 'hot' ? 'text-destructive' : ''}`}
        >
          {label}
          <span className="block h-1 w-11 overflow-hidden rounded-sm bg-muted">
            <i className={`block h-full ${FILL[level]}`} style={{ width: `${Math.min(100, pct)}%` }} />
          </span>
          {shown}%
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function Meters() {
  const t = useT(); // re-renders on a language switch, so the reset time below is re-formatted too
  const st = useAppSelector(selectStats);
  const usage = useAppSelector(selectCapabilitiesKnown)?.usage;
  if (!st || !usage) return null;
  const resets = (l: Limit): string =>
    l.resets_at ? ` · ${t('resets', new Date(l.resets_at).toLocaleString(getLang(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : '';
  const L = st.limits;
  const parts = [
    ...(st.windows ?? []).map((w, i) => <Meter key={`native-${i}`} label={w.minutes == null ? w.label : `${w.minutes % 60 === 0 ? w.minutes / 60 + 'h' : w.minutes + 'm'}`} pct={w.utilization} tip={`${w.label}${resets(w)}`} />),
    st.context && <Meter key="ctx" label={t('ctx')} pct={st.context.pct} tip={t('ctxTip', fmtK(st.context.used), fmtK(st.context.max))} />,
    L?.five_hour && <Meter key="h5" label={t('h5')} pct={L.five_hour.utilization} tip={`${t('h5Tip')}${resets(L.five_hour)}`} />,
    L?.seven_day && <Meter key="week" label={t('week')} pct={L.seven_day.utilization} tip={`${t('weekTip')}${resets(L.seven_day)}`} />,
    st.cost != null && !L && (
      <Tooltip key="cost">
        <TooltipTrigger asChild>
          <span tabIndex={0} className="cursor-default">${st.cost.toFixed(2)}</span>
        </TooltipTrigger>
        <TooltipContent>{t('costTip')}</TooltipContent>
      </Tooltip>
    ),
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="flex flex-none items-center gap-3 font-mono text-[11px] text-muted-foreground">{parts}</span>;
}
