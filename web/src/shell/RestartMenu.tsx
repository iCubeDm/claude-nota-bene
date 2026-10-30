import { useEffect, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { restartAgent, restartServer, selectSwitching } from '@/controls/slice.ts';
import { selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { apiFetch } from '@/net/auth.ts';

export const INFO_POLL_MS = 20_000;

/**
 * `/info.supervised` and `.codeChanged`: read on load and after every reconnect (a relaunch may change them), on window
 * focus, and every 20 s while the tab is visible (the agent edits server code while the user watches). false on failure.
 */
function useServerInfo(): { supervised: boolean; codeChanged: boolean } {
  const conn = useAppSelector(selectConn);
  const [info, setInfo] = useState({ supervised: false, codeChanged: false });
  useEffect(() => {
    if (conn !== 'open') return;
    let live = true;
    const read = () => {
      apiFetch('/info').then((r) => r.json()).then((j: { supervised?: unknown; codeChanged?: unknown }) => {
        if (live) setInfo({ supervised: j.supervised === true, codeChanged: j.codeChanged === true });
      }).catch(() => { if (live) setInfo({ supervised: false, codeChanged: false }); });
    };
    read();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') read(); }, INFO_POLL_MS);
    window.addEventListener('focus', read);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', read); };
  }, [conn]);
  return info;
}

/** ↻ restarts the agent (R-M4-1); the chevron opens the menu, whose second item restarts the whole server (R-M5-1). */
export function RestartMenu() {
  const t = useT();
  const d = useAppDispatch();
  const switching = useAppSelector(selectSwitching);
  const { supervised, codeChanged } = useServerInfo();
  const btn = 'cursor-pointer border border-border-soft px-2 py-0.5 text-[11px] font-medium hover:text-foreground disabled:cursor-default disabled:opacity-50';
  return (
    <span className="flex items-center gap-1.5">
      {supervised && codeChanged && (
        <button type="button" id="codeUpdatedBtn" title={t('codeUpdatedTip')} disabled={switching} onClick={() => void d(restartServer())} className={`${btn} rounded-md border-warn text-warn`}>
          {t('codeUpdated')}
        </button>
      )}
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
    </span>
  );
}
