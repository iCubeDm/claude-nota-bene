import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { useAppSelector } from '@/store/store.ts';
import { selectTaskByCall, selectTaskControls } from './slice.ts';
import { BackgroundButton, BTN, StopButton, useForeground } from './TaskButtons.tsx';

/**
 * The small menu on a subagent's card in the feed (Stop, To background), so the common case does not need the drawer.
 * Present only while a task of that call runs, and only on a server that has the controls.
 */
export function CardMenu({ call }: { call: string }) {
  const t = useT();
  const hit = useAppSelector((s) => selectTaskByCall(s, call));
  const controls = useAppSelector(selectTaskControls);
  const foreground = useForeground(hit?.task);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);
  useEffect(() => { if (!hit) setOpen(false); }, [hit]);
  if (!hit || !controls) return null;
  return (
    <span ref={box} data-anchor-skip className="relative flex-none">
      <button type="button" data-agent-menu aria-haspopup="menu" aria-expanded={open} aria-label={t('taskMenu')} title={t('taskMenu')} onClick={() => setOpen((v) => !v)} className={`${BTN} px-1.5`}>⋯</button>
      {open && (
        <span role="menu" data-agent-menu-items className="absolute top-full right-0 z-[16] mt-1 flex flex-col gap-1 rounded-md border border-border-soft bg-card p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
          <StopButton id={hit.id} className={`${BTN} w-full text-left whitespace-nowrap`} />
          {foreground && <BackgroundButton task={hit.task} className={`${BTN} w-full text-left whitespace-nowrap`} after={() => setOpen(false)} />}
        </span>
      )}
    </span>
  );
}
