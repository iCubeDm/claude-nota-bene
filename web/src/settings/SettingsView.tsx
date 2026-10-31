import { useAppSelector } from '@/store/store.ts';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { MODES, type AgentMode as Mode } from '@nota-bene/shared';
import { Button } from '@/components/ui/button.tsx';
import { apiFetch } from '@/net/auth.ts';
import { ConfirmDialog } from '@/controls/ConfirmDialog.tsx';
import { kb } from '@/controls/SessionPicker.tsx';
import { getLang, chooseLang, LANGS, t as tNow, useT, type Lang } from '@/i18n/index.ts';

type Size = { bytes: number; files: number };
/** `history`: the archive before compactions (R-M7-1); absent from a server older than M7-12 */
type Storage = { attachments: Size; comments: Size; history?: Size; trash: Size; marks: Size & { root: string }; unreferenced: Size };
type WindowRow = {
  port: number; root: string; pid: number; startedAt: number; current: boolean;
  state: 'live' | 'restarting' | 'silent' | 'stale';
  session: string | null; title: string | null; supervised: boolean; busy: boolean; clients: number;
};
type About = { version: string; stateDir: string; logs: string[]; node: string; pid: number };
type Action = 'restart-agent' | 'restart-server' | 'stop';

// macOS and Linux home folders
const short = (d: string) => d.replace(/^\/(Users|home)\/[^/]+/, '~');
const uptime = (since: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - since) / 60000));
  return m < 60 ? tNow('upMin', m) : m < 1440 ? tNow('upHMin', Math.floor(m / 60), m % 60) : tNow('upD', Math.floor(m / 1440));
};

async function getJson<T>(url: string): Promise<T> {
  const r = await apiFetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}
const postJson = (url: string, body: unknown) =>
  apiFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** One load per activation; `reload` after an action. A failure is shown in the section, never thrown. */
function useLoad<T>(url: string, active: boolean): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    getJson<T>(url).then((d) => { if (live) { setData(d); setError(null); } }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [url, active, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="nb-card nb-prose px-6 py-5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex-1 text-[15px] font-semibold text-foreground">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const Row = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="flex items-baseline gap-4 py-1.5 text-[13px]">
    <div className="w-56 flex-none text-muted-foreground">{label}</div>
    <div className="min-w-0 flex-1 break-words text-foreground">{children}</div>
  </div>
);

/**
 * The Settings tab (M6-15, R-M6-4): everything outside a session. Windows (every Nota Bene window, with restart and
 * stop for the others), Storage (sizes; moving unreferenced pasted images to the trash), Defaults, About.
 */
export function SettingsView({ active }: { active: boolean }) {
  const capabilities = useAppSelector((s) => s.controls.capabilities);
  const t = useT();
  const windows = useLoad<WindowRow[]>('/system/windows', active);
  const storage = useLoad<Storage>('/system/storage', active);
  const about = useLoad<About>('/system/about', active);
  const prefs = useLoad<{ defaultMode: Mode }>('/system/prefs', active);
  const [ask, setAsk] = useState<{ title: string; body: string; confirm: string; run: () => Promise<void> } | null>(null);
  // the port whose action is in flight: that row's buttons are off until it settles (no double relays)
  const [pending, setPending] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const act = (w: WindowRow, action: Action) => async () => {
    setNote(null);
    setPending(w.port);
    try {
      // the row's identity: the server refuses if another window has taken the port since this list was loaded
      const r = await postJson('/system/windows/action', { port: w.port, action, root: w.root, pid: w.pid, startedAt: w.startedAt }).catch(() => null);
      if (r?.ok) return setNote(t('winSent'));
      const body = r ? await r.text().catch(() => '') : '';
      const inner = r?.status === 502 ? (JSON.parse(body || '{}') as { status?: number }).status : undefined;
      setNote(!r ? t('setLoadFail', 'network')
        : body === 'window changed' ? t('winChanged')
        : inner === 403 || inner === 404 ? t('winOld') // a window started before the control route existed
        : t('setLoadFail', inner ? `${r.status} (${inner})` : `${r.status} ${body}`.trim()));
    } catch (e) {
      setNote(t('setLoadFail', e instanceof Error ? e.message : String(e)));
    } finally {
      setTimeout(() => { setPending(null); windows.reload(); }, action === 'restart-agent' ? 500 : 1500);
    }
  };
  // every action on another window ends its running turn: ask first when it is working, and always for Stop
  const confirmAct = (w: WindowRow, action: Action, label: string) => {
    if (action !== 'stop' && !w.busy) return void act(w, action)();
    const body = action === 'stop' ? t('winStopQ', w.port, short(w.root)) : t('winBusyQ', label, w.port, short(w.root));
    setAsk({ title: label, body: w.busy && action === 'stop' ? `${body}\n${t('winBusyNote')}` : body, confirm: label, run: act(w, action) });
  };
  const clean = async () => {
    try {
      const r = await postJson('/system/storage/clean', {});
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as { moved: number; bytes: number; trash: string; errors?: string[] };
      setNote(t('stCleaned', j.moved, kb(j.bytes), short(j.trash)) + (j.errors?.length ? ` · ${t('stErrors', j.errors.length, j.errors[0]!)}` : ''));
    } catch (e) {
      setNote(t('setLoadFail', e instanceof Error ? e.message : String(e)));
    }
    storage.reload();
  };
  const saveMode = async (mode: string) => {
    try {
      const r = await postJson('/system/prefs', { defaultMode: mode });
      if (!r.ok) throw new Error(`${r.status}`);
    } catch (e) {
      setNote(t('setLoadFail', e instanceof Error ? e.message : String(e)));
    }
    prefs.reload();
  };
  const fail = (e: string | null) => e && <div role="alert" className="text-xs text-warn">{t('setLoadFail', e)}</div>;

  return (
    <div className="pb-8">
      {note && <div role="status" className="nb-prose mx-auto mt-4 rounded-lg border border-border-soft bg-card px-4 py-2 text-xs text-foreground">{note}</div>}

      <Section title={t('setWindows')} aside={<Button type="button" variant="ghost" size="sm" onClick={windows.reload}>{t('refresh')}</Button>}>
        {fail(windows.error)}
        {windows.data && !windows.data.length && <div className="text-xs text-muted-foreground">{t('winNone')}</div>}
        <div className="flex flex-col gap-2">
          {windows.data?.map((w) => (
            <div key={w.port} data-window={w.port} className="rounded-lg border border-border-soft px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-foreground">{w.root.split('/').filter(Boolean).pop() ?? w.root}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{short(w.root)}</span>
                <span className="font-mono text-[11px] text-muted-foreground">:{w.port}</span>
                {w.current && <span className="rounded bg-primary/15 px-1.5 text-[11px] text-primary">{t('winThis')}</span>}
                {w.state !== 'live' && <span className="text-[11px] text-warn">{t(`win_${w.state}`)}</span>}
              </div>
              {w.state === 'live' && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {[w.title, w.busy ? t('winBusy') : t('winIdle'), w.clients ? t('winTabs', w.clients) : t('winHeadless'), t('winUp', uptime(w.startedAt))].filter(Boolean).join(' · ')}
                </div>
              )}
              {!w.current && w.state === 'live' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button asChild variant="outline" size="sm"><a href={`http://127.0.0.1:${w.port}/`} target="_blank" rel="noopener noreferrer">{t('winOpen')}</a></Button>
                  <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'restart-agent', t('winRestartAgent'))}>{t('winRestartAgent')}</Button>
                  {w.supervised && <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'restart-server', t('winRestartServer'))}>{t('winRestartServer')}</Button>}
                  <Button type="button" variant="outline" size="sm" disabled={pending === w.port} onClick={() => confirmAct(w, 'stop', t('winStop'))}>{t('winStop')}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title={t('setStorage')}>
        {fail(storage.error)}
        {storage.data && (
          <>
            <Row label={t('stAttachments')}>{kb(storage.data.attachments.bytes)} · {t('stFiles', storage.data.attachments.files)}</Row>
            <Row label={t('stComments')}>{kb(storage.data.comments.bytes)} · {t('stFiles', storage.data.comments.files)}</Row>
            {storage.data.history && <Row label={t('stHistory')}>{kb(storage.data.history.bytes)} · {t('stFiles', storage.data.history.files)}</Row>}
            <Row label={t('stMarks')}>{kb(storage.data.marks.bytes)} · {t('stFiles', storage.data.marks.files)}</Row>
            <Row label={t('stTrash')}>{kb(storage.data.trash.bytes)} · {t('stFiles', storage.data.trash.files)}</Row>
            <div className="mt-3">
              {storage.data.unreferenced.files ? (
                <Button type="button" variant="outline" size="sm"
                  onClick={() => setAsk({ title: t('stClean'), body: t('stCleanQ', storage.data!.unreferenced.files, kb(storage.data!.unreferenced.bytes)), confirm: t('stClean'), run: clean })}>
                  {t('stClean')} · {storage.data.unreferenced.files}
                </Button>
              ) : <span className="text-xs text-muted-foreground">{t('stNothing')}</span>}
            </div>
          </>
        )}
      </Section>

      <Section title={t('setDefaults')}>
        <Row label={t('defLang')}>
          <select aria-label={t('defLang')} value={getLang()} onChange={(e) => chooseLang(e.target.value as Lang)}
            className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-[13px] text-foreground">
            {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Row>
        <Row label={t('defMode')}>
          {fail(prefs.error)}
          {prefs.data && (
            <select aria-label={t('defMode')} value={prefs.data.defaultMode}
              onChange={(e) => void saveMode(e.target.value)}
              className="rounded-md border border-border-soft bg-transparent px-2 py-1 text-[13px] text-foreground">
              {(capabilities?.modes ?? MODES).map((m) => <option key={m} value={m}>{t(`mode_${m}`)}</option>)}
            </select>
          )}
        </Row>
      </Section>

      <Section title={t('setAbout')}>
        {fail(about.error)}
        {about.data && (
          <>
            <Row label={t('aboutVersion')}><span className="font-mono text-xs">{about.data.version}</span></Row>
            <Row label={t('aboutState')}><span className="font-mono text-xs">{short(about.data.stateDir)}</span></Row>
            <Row label={t('aboutLogs')}>{about.data.logs.length ? <span className="font-mono text-xs">{about.data.logs.map(short).join(', ')}</span> : <span className="text-xs text-muted-foreground">{t(capabilities?.provider === 'codex' ? 'aboutNoLogsCodex' : 'aboutNoLogs')}</span>}</Row>
            <Row label={t('aboutNode')}><span className="font-mono text-xs">{about.data.node} · pid {about.data.pid}</span></Row>
          </>
        )}
      </Section>

      {ask && (
        <ConfirmDialog title={ask.title} body={ask.body} confirm={ask.confirm}
          onCancel={() => setAsk(null)} onConfirm={() => { const run = ask.run; setAsk(null); void run(); }} />
      )}
    </div>
  );
}
