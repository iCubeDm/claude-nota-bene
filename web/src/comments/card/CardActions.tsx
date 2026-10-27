import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';

const BTN = 'inline-flex items-center px-0.5 text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground [&_svg]:size-[13px]';
const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'aria-hidden': true } as const;

/** `noTitle`: the button already sits in a Radix Tooltip, so a native title would show a second one. */
function IconButton({ label, className = '', noTitle = false, children, ...rest }: { label: string; className?: string; noTitle?: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" title={noTitle ? undefined : label} aria-label={label} className={`${BTN} ${className} disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted-foreground`} {...rest}>
      {children}
    </button>
  );
}

/** The buttons of a pending card: help / save / cancel while editing, edit / delete otherwise. */
export function CardActions({ editing, switching, start, finish, remove }: {
  editing: boolean;
  switching: boolean;
  start: () => void;
  finish: (save: boolean) => void;
  remove: () => void;
}) {
  const t = useT();
  const noFocusSteal = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };
  return (
    <span className="flex items-center gap-0.5">
      {editing ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton label={t('editTip')} noTitle {...noFocusSteal}>
                <svg {...svg} strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" /><path d="M12 17h.01" /></svg>
              </IconButton>
            </TooltipTrigger>
            <TooltipContent className="whitespace-pre-line">{t('editTip')}</TooltipContent>
          </Tooltip>
          <IconButton label={t('save')} className="hover:text-success" {...noFocusSteal} onClick={() => finish(true)}>
            <svg {...svg} strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
          </IconButton>
          <IconButton label={t('cancel')} {...noFocusSteal} onClick={() => finish(false)}>
            <svg {...svg} strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </IconButton>
        </>
      ) : (
        <>
          <IconButton label={t('edit')} disabled={switching} title={switching ? t('switching') : undefined} onClick={start}>
            <svg {...svg} strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
          </IconButton>
          <IconButton label={t('del')} className="hover:text-destructive" disabled={switching} title={switching ? t('switching') : undefined} onClick={remove}>
            <svg {...svg} strokeWidth="2"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
          </IconButton>
        </>
      )}
    </span>
  );
}
