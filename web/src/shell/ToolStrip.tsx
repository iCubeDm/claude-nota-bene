import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { selectCommentsUi, selectPending, setPanelOpen } from '@/comments/slice.ts';
import { selectTree, setTreeOpen } from '@/tree/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';

/** One tool-window button: an icon that toggles its panel, the name in a tooltip on the panel's side. */
function ToolButton({ id, label, pressed, side, onClick, children }: {
  id: string; label: string; pressed: boolean; side: 'left' | 'right'; onClick: () => void; children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          id={id}
          aria-pressed={pressed}
          aria-label={label}
          onClick={onClick}
          className={`relative grid size-[28px] place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground ${pressed ? 'bg-primary/15 text-primary hover:text-primary' : ''}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side === 'left' ? 'right' : 'left'}>{label}</TooltipContent>
    </Tooltip>
  );
}

const strip = 'flex w-9 flex-none flex-col items-center gap-1 bg-chrome py-1.5';

/** The thin IntelliJ-style strips on both sides of the work area (R-M6-3): Files on the left, Comments on the right. */
export function LeftStrip() {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectTree).open;
  return (
    <nav aria-label={t('toolsLeft')} data-strip="left" className={`${strip} border-r border-border-soft`}>
      <ToolButton id="toggleTree" label={t('files')} pressed={open} side="left" onClick={() => d(setTreeOpen(!open))}>
        <Svg size={16}>{ICONS.dir}</Svg>
      </ToolButton>
    </nav>
  );
}

export function RightStrip() {
  const t = useT();
  const d = useAppDispatch();
  const open = useAppSelector(selectCommentsUi).panelOpen;
  const n = useAppSelector(selectPending).length;
  return (
    <nav aria-label={t('toolsRight')} data-strip="right" className={`${strip} border-l border-border-soft`}>
      <ToolButton id="toggleComments" label={n ? t('commentsN', n) : t('comments')} pressed={open} side="right" onClick={() => d(setPanelOpen(!open))}>
        <Svg size={16}>{ICONS.comments}</Svg>
        {n > 0 && (
          <span data-testid="pending-badge" className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-nb-accent px-1 text-center text-[9px] font-semibold leading-3.5 text-background">
            {n}
          </span>
        )}
      </ToolButton>
    </nav>
  );
}
