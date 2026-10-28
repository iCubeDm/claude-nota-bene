import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { sendBatch } from '@/comments/send.ts';
import { selectPending } from '@/comments/slice.ts';
import { CompactClear } from '@/controls/CompactClear.tsx';
import { ModePill } from '@/controls/ModePill.tsx';
import { nextMode, pickMode, selectCapabilities, selectMode, selectSuggestion, selectSwitching } from '@/controls/slice.ts';
import { ShortcodePicker } from '@/comments/ShortcodePicker.tsx';
import { MentionPicker } from './MentionPicker.tsx';
import { Meters } from '@/stats/Meters.tsx';
import { Attachments } from '@/attachments/Attachments.tsx';
import { hasFiles, useImageIntake } from '@/attachments/useImageIntake.ts';
import { addImage, removeImage, selectDraft, selectImages, selectUploading, setDraft, uploadFinished, uploadStarted } from './slice.ts';
import { interrupt, selectBusy, selectConn, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { BINDINGS, keysLabel } from '@/shell/keymap.ts';
import { PLAYER_HELP } from '@/media/playerKeys.ts';

export function Composer() {
  const t = useT();
  const dispatch = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const conn = useAppSelector(selectConn);
  const nPending = useAppSelector(selectPending).length;
  const mode = useAppSelector(selectMode);
  const caps = useAppSelector(selectCapabilities);
  const text = useAppSelector(selectDraft);
  const images = useAppSelector(selectImages);
  const uploading = useAppSelector(selectUploading) > 0;
  // mid-switch the server refuses sends: Send is off (Enter too) and the draft simply waits for the new session
  const switching = useAppSelector(selectSwitching);
  const suggestion = useAppSelector(selectSuggestion);
  const showSug = !!suggestion && !text && !busy && !switching;
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState('');
  const [dropping, setDropping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the same status spot as "offline": a short-lived note (onlyImages / imgFail)
  const flash = (msg: string) => {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 3000);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const intake = useImageIntake({
    onUploaded: (im) => void dispatch(addImage(im)),
    notify: flash,
    onBusy: (d) => void dispatch(d > 0 ? uploadStarted() : uploadFinished()),
  });

  // drop anywhere in the window attaches to the message (a drop inside an open comment popup is taken there first)
  const addRef = useRef(intake.add);
  addRef.current = intake.add;
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(true);
    };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDropping(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      addRef.current(e.dataTransfer?.files ?? []);
    };
    // capture: a drop taken (and stopped) by the comment popup must still clear the highlight
    const clear = () => setDropping(false);
    document.addEventListener('drop', clear, true);
    document.addEventListener('dragend', clear, true);
    document.addEventListener('dragover', over);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('drop', clear, true);
      document.removeEventListener('dragend', clear, true);
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
    };
  }, []);

  // autosize; max-height (40vh) is applied by CSS
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // empty: stay one line — a long placeholder would otherwise wrap and grow the field (prototype clips it)
    if (text) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // a send that failed while offline is forgotten once the socket is back, so a later drop shows no stale label
  useEffect(() => {
    if (conn === 'open') setFailed(false);
  }, [conn]);

  // Esc interrupts while busy, unless something else already handled it
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) dispatch(interrupt());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, dispatch]);

  const submit = (force: boolean) => {
    if (uploading || switching) return;
    const r = dispatch(sendBatch(force));
    if (r === 'empty' || r === 'switching') return;
    setFailed(r === 'offline');
    if (r === 'sent') ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // an open @ / : picker takes Tab at window capture and stops it, so this is only reached with no picker to serve
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing && showSug) {
      e.preventDefault();
      dispatch(setDraft(suggestion));
      // the controlled value lands on the next render; put the caret after it
      requestAnimationFrame(() => ref.current?.setSelectionRange(suggestion.length, suggestion.length));
      return;
    }
    if (e.key === 'Tab' && e.shiftKey && !e.nativeEvent.isComposing && mode && caps.modes.length > 1) {
      e.preventDefault();
      dispatch(pickMode(nextMode(mode, caps.modes)));
      return;
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const force = e.metaKey || e.ctrlKey;
    if (e.shiftKey && !force) return;
    e.preventDefault();
    submit(force);
  };

  return (
    <div>
      <div className="flex min-h-0 items-center gap-2.5 pt-2 text-xs text-muted-foreground">
        {busy && (
          <>
            <span className="animate-pulse text-nb-accent">●</span>
            {t('working')}
          </>
        )}
        {failed && conn !== 'open' && <span className="text-warn">{t('offline')}</span>}
        {note && <span className="text-warn">{note}</span>}
      </div>
      <Attachments
        data-testid="composer-thumbs"
        ids={images.map((i) => i.id)}
        pending={intake.pending}
        onRemove={(id) => void dispatch(removeImage(id))}
      />
      <div data-dropping={dropping || undefined} className="flex items-end gap-2 pt-2.5 pb-1.5 data-[dropping]:rounded-[10px] data-[dropping]:outline data-[dropping]:outline-2 data-[dropping]:outline-dashed data-[dropping]:outline-primary">
        <div className="relative flex min-w-0 flex-1">
        <textarea
          ref={ref}
          id="composer-input"
          rows={1}
          value={text}
          placeholder={showSug ? suggestion : t('composerPh')}
          onChange={(e) => {
            dispatch(setDraft(e.target.value));
            setFailed(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={intake.onPaste}
          className={`max-h-[40vh] min-h-10 w-full resize-none rounded-[10px] border border-border-soft bg-[oklch(0.15_0.02_260/0.7)] px-3 py-[9px] text-foreground transition-[border-color,box-shadow] outline-none focus:border-[oklch(0.75_0.18_280/0.6)] focus:shadow-[0_0_0_3px_oklch(0.75_0.18_280/0.12)] ${showSug ? 'pr-16 placeholder:text-foreground placeholder:opacity-45' : 'placeholder:truncate'}`}
        />
        {showSug && (
          <span aria-hidden className="pointer-events-none absolute right-2.5 bottom-2.5 rounded bg-muted px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
            Tab ⇥
          </span>
        )}
        </div>
        <MentionPicker target={ref} />
        <ShortcodePicker target={ref} />
        <span className="inline-flex" title={switching ? t('switching') : uploading ? t('uploadWait') : undefined}>
          <Button type="button" className="h-10" disabled={uploading || switching} onClick={() => submit(false)}>
            {nPending ? t('sendN', nPending) : t('send')}
          </Button>
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              disabled={!busy}
              aria-label={t('stopTip')}
              onClick={() => dispatch(interrupt())}
              className="h-10 bg-muted px-2.5 enabled:bg-destructive/15 enabled:text-destructive enabled:hover:bg-destructive/25 disabled:opacity-35"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
              </svg>
            </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{t('stopTip')}</TooltipContent>
        </Tooltip>
      </div>
      <div data-tools-row className="flex min-h-[30px] items-center gap-2 pb-2">
        <input
          ref={fileIn}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            intake.add(e.target.files ?? []);
            e.target.value = '';
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('keysTip')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6" />
                <path d="M12 17h.01" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{`${t('keysTip')}\n\n${t('hkTitle')}\n${BINDINGS.map((b) => `${keysLabel(b)} — ${t(b.id)}`).join('\n')}\n\n${t('pkTitle')}\n${PLAYER_HELP.map(([k, id]) => `${k} — ${t(id)}`).join('\n')}`}</TooltipContent>
        </Tooltip>
        <ModePill />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t('attach')} onClick={() => fileIn.current?.click()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="whitespace-pre-line">{t('attach')}</TooltipContent>
        </Tooltip>
        <span className="grow" />
        <Meters />
        <CompactClear />
      </div>
    </div>
  );
}
