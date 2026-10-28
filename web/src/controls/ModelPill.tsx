import { useState } from 'react';
import type { EffortLevel, ModelOption } from '@nota-bene/shared';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { selectStats } from '@/stats/slice.ts';
import { selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { pickModel, selectModel, selectModelSwitchable, selectModels, selectSwitching } from './slice.ts';

/**
 * The row for the model id in use. The CLI reports resolved ids, the list has aliases, and two rows can resolve to one
 * id (`default` and `opus`): an alias we set wins, a resolved id takes the first row that has it.
 */
const rowFor = (models: ModelOption[], id: string | null | undefined): ModelOption | undefined =>
  id ? (models.find((o) => o.value === id) ?? models.find((o) => o.resolved === id)) : undefined;

/** the aliases (`sonnet`) are the everyday list; explicit ids (`claude-sonnet-5`) go under "Other versions" */
const isAlias = (o: ModelOption) => !o.value.startsWith('claude-');
const resolvedOf = (o: ModelOption) => o.resolved ?? o.value;

/**
 * The model in the header. The list comes from the agent; a model with effort levels shows them right under it.
 * Choosing applies from the next reply. A model change drops the prompt cache, so the other models say what the next
 * reply will re-read (the context meter's tokens); an effort change keeps the cache and says nothing.
 */
export function ModelPill() {
  const t = useT();
  const dispatch = useAppDispatch();
  const cur = useAppSelector(selectModel);
  const models = useAppSelector(selectModels);
  const switching = useAppSelector(selectSwitching);
  const switchable = useAppSelector(selectModelSwitchable);
  const used = useAppSelector(selectStats)?.context?.used ?? 0;
  const sessionModel = useAppSelector(selectSession)?.model ?? null;
  const id = cur?.model ?? sessionModel;
  const current = rowFor(models, id);
  const [more, setMore] = useState(false);
  if (!id && !switchable) return null; // nothing known yet
  const label = (current?.name ?? id ?? t('modelUnknown')) + (cur?.effort ? ` · ${t(`effort_${cur.effort}`)}` : '');
  const trigger = (
    <button
      type="button"
      aria-label={t('modelTip')}
      disabled={switching || !switchable}
      className="inline-flex h-[24px] items-center rounded-full border border-border-soft bg-transparent px-2.5 font-mono text-[11px] text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-70"
    >
      {label}
    </button>
  );
  if (!switchable) return trigger;
  const kTokens = Math.max(1, Math.round(used / 1000));
  const pick = (o: ModelOption, effort?: EffortLevel) => {
    if (o === current && effort === cur?.effort) return;
    void dispatch(pickModel(o.value, effort));
  };
  const others = models.filter((o) => !isAlias(o));
  const showMore = more || (!!current && !isAlias(current));
  const row = (o: ModelOption) => {
    const here = o === current;
    const warn = used > 0 && (current ? resolvedOf(o) !== resolvedOf(current) : true); // the same resolved id keeps the cache
    return (
      <div key={o.value} role="group" aria-label={o.name} className="py-0.5">
        <DropdownMenuItem
          aria-current={here || undefined}
          onSelect={() => pick(o, here ? cur?.effort : cur?.effort && o.efforts?.includes(cur.effort) ? cur.effort : undefined)}
          className={`block px-2.5 py-[7px] ${here ? 'bg-muted' : ''}`}
        >
          <b className="block text-[13px] font-medium">{o.name}</b>
          <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{o.description}</span>
          {warn && <span data-testid="cache-warn" className="mt-0.5 block text-[11.5px] leading-snug text-warn">{t('modelCacheWarn', kTokens)}</span>}
        </DropdownMenuItem>
        {o.efforts && (
          <div role="group" aria-label={t('effortLabel')} className="flex flex-wrap items-center gap-1 px-2.5 pb-1 pt-0.5">
            <span className="mr-1 text-[11px] text-muted-foreground">{t('effortLabel')}</span>
            {o.efforts.map((e) => (
              <DropdownMenuItem
                key={e}
                aria-current={(here && cur?.effort === e) || undefined}
                onSelect={() => pick(o, e)}
                className={`inline-flex h-[22px] w-auto items-center rounded-full border border-border-soft px-2 py-0 text-[11px] ${here && cur?.effort === e ? 'bg-muted font-medium' : ''}`}
              >
                {t(`effort_${e}`)}
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </div>
    );
  };
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('modelTip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="bottom" align="end" className="w-[320px]">
        {models.filter(isAlias).map(row)}
        {others.length > 0 && (
          <>
            <DropdownMenuItem
              aria-expanded={showMore}
              onSelect={(e) => { e.preventDefault(); setMore(!more); }}
              className="px-2.5 py-1.5 text-[12px] text-muted-foreground"
            >
              {showMore ? '▾' : '▸'} {t('modelOthers')}
            </DropdownMenuItem>
            {showMore && others.map(row)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
