import type { QuickLabelId } from '@nota-bene/shared';
import { TooltipContent } from '@/components/ui/tooltip.tsx';
import { instructionOf, labelText } from './labels.ts';

/** Tooltip of a quick-label chip (the chip shows only the emoji): the label, and what the agent is told. `note` replaces the instruction. */
export function LabelTip({ id, note }: { id: QuickLabelId; note?: string }) {
  const instruction = note ?? instructionOf({ label: id });
  return (
    <TooltipContent className="max-w-[300px]">
      <div className="font-medium text-foreground">{labelText(id)}</div>
      {instruction && <div>{instruction}</div>}
    </TooltipContent>
  );
}
