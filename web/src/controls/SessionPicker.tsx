import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { getLang, t as tNow, useT } from '@/i18n/index.ts';
import { selectBusy, selectSession, useAppDispatch, useAppSelector } from '@/store/store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { selectSwitching, switchSession } from './slice.ts';
import { REFUSED, useNote } from './useNote.ts';
import { apiFetch } from '@/net/auth.ts';

/** GET /sessions (server/src/sessions.ts SessionsView). */
export type SessionsView = {
  current: string | null;
  root: string;
  sessions: { id: string; title: string; at: number; size: number; cwd: string }[];
};
type Item = SessionsView['sessions'][number];

/** Prototype `ago`: just now, N min ago, N h ago, then a short date. */
export const ago = (at: number, now = Date.now()): string => {
  const m = Math.round((now - at) / 60000);
  return m < 1 ? tNow('justNow') : m < 60 ? tNow('minAgo', m) : m < 1440 ? tNow('hAgo', Math.round(m / 60))
    : new Date(at).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' });
};
/** Prototype `kb`: MB above 1e6 bytes, whole KB below. */
export const kb = (n: number): string => (n > 1e6 ? `${(n / 1e6).toFixed(1)} ${tNow('mb')}` : `${Math.round(n / 1e3)} ${tNow('kb')}`);
const short = (d: string) => d.replace(/^\/Users\/[^/]+/, '~');

/** This project first, then the other folders in first-appearance order; empty groups are dropped. */
export function groupSessions(v: SessionsView): { dir: string; here: boolean; items: Item[] }[] {
  const groups = new Map<string, Item[]>([[v.root, []]]);
  for (const x of v.sessions) {
    if (!groups.has(x.cwd)) groups.set(x.cwd, []);
    groups.get(x.cwd)!.push(x);
  }
  return [...groups].filter(([, xs]) => xs.length).map(([dir, items]) => ({ dir, here: dir === v.root, items }));
}

const isView = (v: unknown): v is SessionsView => {
  const o = v as SessionsView;
  return !!o && typeof o.root === 'string' && Array.isArray(o.sessions);
};

type Ask = { id: string | null; title: string; dir: string };

/** A failed load's text for the menu: one short line, never an HTML error page. */
export const brief = (status: number | null, body: string): string => {
  const plain = /^\s*</.test(body) ? '' : body.replace(/\s+/g, ' ').trim();
  const s = plain || (status ? `HTTP ${status}` : '');
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

/**
 * "Sessions ▾" in the header (claude --resume): every session of every folder, this project first. Picking one asks,
 * then sends `switch`; the header says "switching…" until the new session is announced. Off while the agent works or
 * a switch runs (R-M4-4).
 */
export function SessionPicker() {
  const t = useT();
  const codex = useAppSelector((s) => s.controls.capabilities?.provider === 'codex');
  const dispatch = useAppDispatch();
  const busy = useAppSelector(selectBusy);
  const switching = useAppSelector(selectSwitching);
  const off = busy || switching;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SessionsView | string | null>(null); // string: the load failed
  const [q, setQ] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const filter = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const loadSeq = useRef(0);
  const confirmed = useRef(false);
  const [note, showNote] = useNote();
  const session = useAppSelector(selectSession);

  // another session or root now (another window switched, a /clear): what the menu or the question showed is stale
  const sessionKey = session ? `${session.id}\n${session.root}` : '';
  const shownFor = useRef(sessionKey);
  useEffect(() => {
    if (shownFor.current === sessionKey) return;
    shownFor.current = sessionKey;
    setOpen(false);
    setAsk(null);
  }, [sessionKey]);

  // the agent started working (another window sent) while the menu was open: nothing in it may be picked now
  useEffect(() => {
    if (off) setOpen(false);
  }, [off]);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (!o) return;
    setQ('');
    setView(null);
    const seq = ++loadSeq.current;
    void apiFetch('/sessions')
      .then(async (r) => {
        if (!r.ok) throw new Error(brief(r.status, await r.text().catch(() => '')));
        const v: unknown = await r.json();
        if (!isView(v)) throw new Error('bad /sessions answer');
        return v;
      })
      .then((v) => { if (seq === loadSeq.current) setView(v); }, (e: unknown) => {
        if (seq === loadSeq.current) setView(t('sessFail') + brief(null, e instanceof Error ? e.message : String(e)));
      });
  };

  const pick = (a: Ask) => {
    // focus goes back to the trigger first, so the dialog returns it there when it closes
    trigger.current?.focus();
    setOpen(false);
    setAsk(a);
  };

  const v = typeof view === 'object' ? view : null;
  const needle = q.trim().toLowerCase();
  const groups = v
    ? groupSessions(v)
      .map((g) => ({ ...g, items: g.items.filter((x) => !needle || `${x.title} ${x.cwd}`.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length)
    : [];

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            id="sessBtn"
            title={t(codex ? 'sessTipCodex' : 'sessTip')}
            disabled={off}
            className="inline-flex flex-none items-center gap-1 rounded border border-border-soft px-2 py-px font-mono text-[11px] text-muted-foreground hover:enabled:border-primary hover:enabled:text-foreground disabled:cursor-default disabled:opacity-35"
          >
            {t('sessions')}
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={t('sessions')}
          collisionPadding={8}
          className="flex max-h-[min(70vh,560px)] w-[460px] flex-col"
          // focus the filter once the menu is positioned and shown, not while the popper still measures it
          onOpenAutoFocus={(e) => { e.preventDefault(); requestAnimationFrame(() => filter.current?.focus({ preventScroll: true })); }}
          onCloseAutoFocus={(e) => { if (ask) e.preventDefault(); }}
          // Esc protocol: consumed here, so the Composer does not also read it
          onEscapeKeyDown={(e) => { e.preventDefault(); setOpen(false); trigger.current?.focus(); }}
        >
          <input
            ref={filter}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('sessFilter')}
            className="m-1 flex-none rounded-md border border-border-soft bg-transparent px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
          />
          <div className="min-h-0 overflow-auto">
            <button
              type="button"
              data-sess-item=""
              onClick={() => v && pick({ id: null, title: '', dir: v.root })}
              disabled={!v}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50"
            >
              <span data-t className="block text-[13px] text-primary">{t('newHere')}</span>
            </button>
            {view === null && <div className="px-2.5 py-2 text-xs text-muted-foreground">{t('loading')}</div>}
            {typeof view === 'string' && <div className="px-2.5 py-2 text-xs text-destructive">{view}</div>}
            {groups.map((g) => (
              <div key={g.dir}>
                <div
                  data-sess-group=""
                  data-here={g.here || undefined}
                  title={g.dir}
                  className={`truncate px-2.5 pt-2.5 pb-1 font-mono text-[10.5px] ${g.here ? 'text-primary' : 'text-muted-foreground'}`}
                >
                  {g.here ? t('thisProject') : ''}{short(g.dir)}
                </div>
                {g.items.map((x) => {
                  const cur = x.id === v!.current;
                  const title = x.title || t('untitled');
                  return (
                    <button
                      key={x.id}
                      type="button"
                      data-sess-item=""
                      aria-current={cur || undefined}
                      disabled={cur}
                      onClick={() => pick({ id: x.id, title, dir: x.cwd })}
                      className={`block w-full rounded-md px-2.5 py-1.5 text-left hover:enabled:bg-muted ${cur ? 'cursor-default bg-primary/10' : ''}`}
                    >
                      <span data-t className="block truncate text-[13px] text-foreground">{title}</span>
                      <span className="block font-mono text-[10.5px] text-muted-foreground">
                        {x.id.slice(0, 8)} · {ago(x.at)} · {kb(x.size)}{cur ? t('openNow') : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {note && <span role="status" className="flex-none text-[11px] text-warn">{note}</span>}
      {ask && v && (
        <ConfirmDialog
          title={ask.id ? t('openQ', ask.title) : t('newQ')}
          body={`${ask.dir !== v.root ? t('moveQ', ask.dir) : ''}${t(codex ? 'switchWarnCodex' : 'switchWarn')}`.trim()}
          confirm={t('switchBtn')}
          onConfirm={() => {
            setAsk(null);
            const r = dispatch(switchSession(ask.id, ask.dir));
            // sent: the trigger is disabled now, so the focus goes to the composer (the draft waits there)
            confirmed.current = r === 'sent';
            if (r !== 'sent') {
              showNote(t('switchFail') + t(REFUSED[r]));
            }
          }}
          onCancel={() => { confirmed.current = false; setAsk(null); }}
          focusAfter={() => (confirmed.current ? document.getElementById('composer-input') : null)}
        />
      )}
    </>
  );
}
