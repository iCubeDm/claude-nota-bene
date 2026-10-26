import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { selectBusy, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { runCommand, selectSwitching } from './slice.ts';
import { REFUSED, useNote } from './useNote.ts';

const ICON = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

/** /compact (at once) and /clear (after a confirmation); both off while the agent works (R-M4-4) or a switch runs. */
export function CompactClear() {
  const t = useT();
  const dispatch = useAppDispatch();
  // off mid-switch too: the server would refuse them as `busy`, and they belong to the session being left
  const busy = useAppSelector((s) => selectBusy(s) || selectSwitching(s));
  const [asking, setAsking] = useState(false);
  const [note, showNote] = useNote();
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t('compactTip')} onClick={() => dispatch(runCommand('compact'))}>
            <svg {...ICON}><path d="m7 4 5 5 5-5M7 20l5-5 5 5" /></svg>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] whitespace-pre-line">{t('compactTip')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" disabled={busy} aria-label={t('clearTip')} onClick={() => setAsking(true)}>
            <svg {...ICON}><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" /></svg>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[300px] whitespace-pre-line">{t('clearTip')}</TooltipContent>
      </Tooltip>
      {note && <span role="status" className="flex-none text-[11px] text-warn">{note}</span>}
      {asking && (
        <ConfirmDialog
          title={t('clearTitle')}
          body={t('clearQ')}
          confirm={t('clearBtn')}
          onConfirm={() => {
            setAsking(false);
            // the agent can turn busy while the dialog is open (another window sent): say so, as the session picker does
            const r = dispatch(runCommand('clear'));
            if (r !== 'sent') showNote(t('clearFail') + t(REFUSED[r]));
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}
