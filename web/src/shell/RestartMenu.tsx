import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { restartAgent, restartServer, selectSwitching } from '@/controls/slice.ts';
import { selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';

/** `/info.supervised`: read on load and again after every reconnect (a relaunch may change it). false on any failure. */
function useSupervised(): boolean {
  const conn = useAppSelector(selectConn);
  const [supervised, setSupervised] = useState(false);
  useEffect(() => {
    if (conn !== 'open') return;
    let live = true;
    fetch('/info').then((r) => r.json()).then((j: { supervised?: unknown }) => { if (live) setSupervised(j.supervised === true); }).catch(() => { if (live) setSupervised(false); });
    return () => { live = false; };
  }, [conn]);
  return supervised;
}

/** ↻ restarts the agent (R-M4-1); the chevron opens the menu, whose second item restarts the whole server (R-M5-1). */
export function RestartMenu() {
  const t = useT();
  const d = useAppDispatch();
  const switching = useAppSelector(selectSwitching);
  const supervised = useSupervised();
  const btn = 'cursor-pointer border border-border-soft px-2 py-0.5 text-[11px] font-medium hover:text-foreground disabled:cursor-default disabled:opacity-50';
  return (
    <span className="flex items-center">
      {/* enabled while busy: the escape hatch for a stuck agent (R-M4-4); only a running switch/restart disables it */}
      <button type="button" id="restartBtn" title={t('restartTip')} disabled={switching} onClick={() => d(restartAgent())} className={`${btn} rounded-l-md`}>
        {t('restart')}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" id="restartMenuBtn" aria-label={t('restartMenu')} disabled={switching} className={`${btn} -ml-px rounded-r-md px-1`}>
            ▾
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => d(restartAgent())}>{t('restartAgent')}</DropdownMenuItem>
          {supervised && (
            <DropdownMenuItem title={t('restartServerTip')} onSelect={() => void d(restartServer())}>{t('restartServer')}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
