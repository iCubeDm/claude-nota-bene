import type { ReactNode } from 'react';
import { MARK_COLORS, type MarkColor } from '@nota-bene/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import type { Draft, MarkTool } from './slice.ts';

export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const TOOL_ICONS: Record<MarkTool, ReactNode> = {
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  pen: <path d="M4 18c3-1 4-6 7-7s3 4 6 3 2-5 3-6" />,
  arrow: <><path d="M5 19 19 5" /><path d="M10 5h9v9" /></>,
};
const TOOLS: MarkTool[] = ['rect', 'ellipse', 'pen', 'arrow'];
const TOOL_TIP = { rect: 'toolRect', ellipse: 'toolEllipse', pen: 'toolPen', arrow: 'toolArrow' } as const;

const Icon = ({ children }: { children: ReactNode }) => (
  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={15} height={15}>{children}</svg>
);

function Btn({ label, tip, pressed, disabled, onClick, className = '', children }: {
  label: string; tip?: string; pressed?: boolean; disabled?: boolean; onClick: () => void; className?: string; children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          // a click keeps the focus where it was (the drawing), so Enter still means Comment; Tab still reaches the buttons
          onMouseDown={(e) => e.preventDefault()}
          className={`grid h-7 min-w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${pressed ? 'bg-nb-accent/20 text-nb-accent hover:text-nb-accent' : ''} ${className}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tip ?? label}</TooltipContent>
    </Tooltip>
  );
}

const shell = 'pointer-events-auto flex max-w-full flex-wrap items-center justify-end gap-0.5 rounded-lg border border-border bg-chrome/90 p-0.5 shadow-[0_4px_16px_rgba(0,0,0,0.35)] backdrop-blur';

/** The media tab's top-right overlay: the "Mark up" toggle, or, while marking, tools, colours, undo, Comment, ✕ (all off while `disabled`: a drawing is being saved). */
export function MarkupToolbar({ draft, disabled = false, onEnter, onTool, onColor, onUndo, onComment, onLeave }: {
  draft: Draft; disabled?: boolean; onEnter: () => void; onTool: (t: MarkTool) => void; onColor: (c: MarkColor) => void;
  onUndo: () => void; onComment: () => void; onLeave: () => void;
}) {
  const t = useT();
  if (!draft.on) {
    return (
      <div className={shell}>
        <Btn label={t('markUp')} tip={t('markUpTip')} onClick={onEnter} className="gap-1 px-2 text-xs">
          <span className="flex items-center gap-1.5"><Icon><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13 7 4 4" /></Icon>{t('markUp')}</span>
        </Btn>
      </div>
    );
  }
  const has = draft.shapes.length > 0;
  return (
    <div role="toolbar" aria-label={t('markTools')} className={shell}>
      {TOOLS.map((tool) => (
        <Btn key={tool} label={t(TOOL_TIP[tool])} pressed={draft.tool === tool} disabled={disabled} onClick={() => onTool(tool)}>
          <Icon>{TOOL_ICONS[tool]}</Icon>
        </Btn>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      {MARK_COLORS.map((c, i) => (
        <Btn key={c} label={t('markColor', i + 1)} pressed={draft.color === c} disabled={disabled} onClick={() => onColor(c)}>
          <span className={`block size-3.5 rounded-full border border-black/40 ${draft.color === c ? 'ring-2 ring-nb-accent ring-offset-1 ring-offset-chrome' : ''}`} style={{ background: c }} />
        </Btn>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      <Btn label={t('markUndo', isMac())} disabled={!has || disabled} onClick={onUndo}>
        <Icon><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Icon>
      </Btn>
      <Btn label={t('markCommentTip')} disabled={!has || disabled} onClick={onComment} className="px-2 text-xs font-medium text-nb-accent hover:text-nb-accent">
        {t('markComment')}
      </Btn>
      <Btn label={t('markLeave')} disabled={disabled} onClick={onLeave}>
        <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>
      </Btn>
    </div>
  );
}
