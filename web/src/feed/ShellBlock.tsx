import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { stopShell } from '@/composer/shellMode.ts';
import type { FeedItem } from '@/store/feed.ts';
import { useAppDispatch } from '@/store/store.ts';
import { Button } from '@/components/ui/button.tsx';

/** A `! cmd` run (protocol 11): the command, its merged output, and how it ended; Stop while it runs. */
export function ShellBlock({ item }: { item: Extract<FeedItem, { kind: 'shell' }> }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const [stopping, setStopping] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true); // follow the output while it runs, until the reader scrolls up
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [item.output]);
  const how = item.running ? null
    : item.error ? t('shellCouldNot', item.error)
    : item.stop === 'timeout' ? t('shellTimedOut')
    : item.stop === 'user' ? t('shellStopped')
    : item.code !== null ? t('shellExit', item.code)
    : null; // restored from the transcript: no exit code was kept
  const failed = !item.running && (!!item.error || (item.code !== null && item.code !== 0));
  return (
    <div data-kind="shell" data-testid="shell-block" data-running={item.running || undefined} aria-label={t('shellBlock')} className="my-2.5 overflow-hidden rounded-lg border border-border-soft bg-muted/30">
      <div className="flex items-start gap-2 px-3 py-1.5 font-mono text-[12px]">
        <span aria-hidden className="select-none text-nb-accent">$</span>
        <span data-testid="shell-cmd" className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{item.cmd}</span>
        {item.running ? (
          <>
            <span className="shrink-0 animate-pulse text-[11px] text-nb-accent">● {t('shellRunning')}</span>
            <Button
              type="button" variant="ghost" size="sm" disabled={stopping} title={t('shellStopTip')}
              className="-my-1 h-6 shrink-0 px-2 text-[11px] text-destructive hover:bg-destructive/15"
              onClick={() => { setStopping(true); if (!dispatch(stopShell(item.id))) setStopping(false); }}
            >
              {t('shellStop')}
            </Button>
          </>
        ) : how ? (
          <span data-testid="shell-how" className={`shrink-0 text-[11px] ${failed || item.stop ? 'text-destructive' : 'text-muted-foreground'}`}>{how}</span>
        ) : null}
      </div>
      {(item.output || item.truncated) && (
        <>
          {item.truncated && <div className="border-t border-border-soft px-3 py-0.5 text-[10.5px] text-muted-foreground">{t('shellCut')}</div>}
          <pre
            ref={pre}
            data-testid="shell-output"
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
            className="max-h-[40vh] overflow-auto border-t border-border-soft px-3 py-2 font-mono text-[11.5px] leading-snug break-words whitespace-pre-wrap"
          >{item.output}</pre>
        </>
      )}
      {!item.running && !item.output && !item.truncated && !item.error && (
        <div className="border-t border-border-soft px-3 py-1 text-[11px] italic text-muted-foreground">{t('shellNoOutput')}</div>
      )}
    </div>
  );
}
