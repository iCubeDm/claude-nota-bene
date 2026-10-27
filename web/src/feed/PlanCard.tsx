import { useT } from '@/i18n/index.ts';
import type { FeedItem } from '@/store/feed.ts';
import { answerPermission, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { planApproved } from '@/controls/slice.ts';
import { Markdown } from './Markdown.tsx';

/**
 * ExitPlanMode: the plan as commentable markdown plus approve / keep planning. The commentable root is the plan body
 * only (`data-item-id="plan:<id>"`), so the buttons and the answer line coming and going never shift an anchor's offsets.
 */
export function PlanCard({ item }: { item: Extract<FeedItem, { kind: 'permission' }> }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const before = useAppSelector((s) => s.controls.modeBeforePlan);
  const resolved = item.answer !== undefined;
  const btn = 'rounded-lg border border-transparent px-3 py-1 text-[13px] font-medium';
  return (
    <div
      data-kind="plan-card"
      className={'my-2.5 rounded-[10px] border bg-card px-3 py-2 text-[13px] ' + (resolved || item.archived ? 'border-border-soft' : 'border-[oklch(0.78_0.12_185/0.7)]')}
    >
      <b>{t('planQ')}</b>
      <div data-kind="plan" data-item-id={`plan:${item.id}`} data-final="true" className="my-1.5 max-h-[60vh] overflow-auto">
        <Markdown text={String(item.input.plan)} final />
      </div>
      {resolved ? (
        <span>{t(item.answer ? 'allowed' : 'denied')}</span>
      ) : item.archived ? (
        <span data-archived>{t('askArchived')}</span>
      ) : (
        <>
          <button
            className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}
            onClick={() => {
              dispatch(answerPermission(item.id, true));
              dispatch(planApproved());
            }}
          >
            {t('approvePlan', t(`mode_${before ?? 'default'}`))}
          </button>{' '}
          <button
            className={`${btn} bg-muted text-muted-foreground hover:text-foreground`}
            onClick={() => dispatch(answerPermission(item.id, false))}
          >
            {t('keepPlanning')}
          </button>
        </>
      )}
    </div>
  );
}
