import { useEffect } from 'react';
import { getLang, setLang, useT } from '@/i18n/index.ts';
import { selectCommentsUi, selectPending, setPanelOpen } from '@/comments/slice.ts';
import { selectTree, setTreeOpen } from '@/tree/slice.ts';
import { ICONS, Svg } from '@/tabs/TabStrip.tsx';
import { selectConn, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';

export function Header() {
  const t = useT();
  const other = getLang() === 'ru' ? 'en' : 'ru';
  const conn = useAppSelector(selectConn);
  const session = useAppSelector(selectSession);
  const d = useAppDispatch();
  const panelOpen = useAppSelector(selectCommentsUi).panelOpen;
  const treeOpen = useAppSelector(selectTree).open;
  const pendingN = useAppSelector(selectPending).length;
  // the project, not the app, names the window: several windows on different projects must be told apart
  const project = session?.root.split('/').filter(Boolean).pop() ?? 'Nota Bene';
  useEffect(() => { document.title = `${project} · Nota Bene`; }, [project]);
  return (
    <header className="relative z-[6] flex h-12 flex-none items-center gap-3 border-b border-border-soft bg-chrome px-4 text-xs text-muted-foreground backdrop-blur-[24px]">
      <img id="logo" src="/icon.svg" alt="Nota Bene" className="-mr-1 size-6" />
      <b id="proj" className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{project}</b>
      <span id="root-path" className="min-w-0 truncate font-mono text-[11px] opacity-70">{session?.root ?? ''}</span>
      {/* after the project, not before the logo: it belongs to the project's files */}
      <button
        type="button"
        id="toggleTree"
        aria-pressed={treeOpen}
        aria-label={t('fileTree')}
        title={t('fileTree')}
        onClick={() => d(setTreeOpen(!treeOpen))}
        className={`grid size-7 flex-none place-items-center rounded-lg hover:bg-muted hover:text-foreground ${treeOpen ? 'bg-primary/15 text-primary' : ''}`}
      >
        <Svg size={16}>{ICONS.dir}</Svg>
      </button>
      <span className="flex-1" />
      <span id="conn" className="text-warn">{conn === 'connecting' ? t('connecting') : conn === 'closed' ? t('offline') : ''}</span>
      <span id="session" className="font-mono text-[11px]">{session?.id?.slice(0, 8) ?? ''}</span>
      {/* moves into the tab strip in M2 */}
      <button
        type="button"
        id="toggleComments"
        aria-pressed={panelOpen}
        onClick={() => d(setPanelOpen(!panelOpen))}
        className={`flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium hover:bg-muted hover:text-foreground ${panelOpen ? 'bg-primary/15 text-primary' : ''}`}
      >
        {t('comments')}
        {pendingN > 0 && <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-primary-foreground">{pendingN}</span>}
      </button>
      <button
        type="button"
        id="langBtn"
        title={t('langTip')}
        onClick={() => setLang(other)}
        className="cursor-pointer rounded-md border border-border-soft px-2 py-0.5 text-[11px] font-medium hover:text-foreground"
      >
        {other.toUpperCase()}
      </button>
    </header>
  );
}
