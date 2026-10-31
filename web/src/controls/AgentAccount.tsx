import { useEffect, useState } from 'react';
import { apiFetch } from '@/net/auth.ts';
import { useT } from '@/i18n/index.ts';
import { useAppDispatch, useAppSelector } from '@/store/store.ts';
import { restartAgent } from './slice.ts';

/** Authentication stays in the native Codex process. No credential values reach this page. */
export function AgentAccount() {
  const codex = useAppSelector((s) => s.controls.capabilities?.provider === 'codex');
  const [missing, setMissing] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const t = useT(); const d = useAppDispatch();
  useEffect(() => {
    if (!codex) return;
    let live = true;
    void apiFetch('/agent-account').then((r) => r.json()).then((r) => { if (live) { setMissing(!r.signedIn); setError(r.error ?? ''); } }).catch((e) => { if (live) { setMissing(true); setError(String(e)); } });
    return () => { live = false; };
  }, [codex]);
  if (!codex || !missing) return null;
  const login = async () => {
    try { const r = await apiFetch('/agent-account', { method: 'POST' }); const value = await r.json(); if (!r.ok) throw new Error(value.error); setUrl(value.url); }
    catch (e) { setError(String(e)); }
  };
  return <span className="inline-flex items-center gap-2 text-xs" title={error}>
    <button onClick={() => void login()}>{t('agentSignIn')}</button>
    {url && <a href={url} target="_blank" rel="noreferrer" className="underline">ChatGPT ↗</a>}
    <button onClick={() => {
      void apiFetch('/agent-account').then((r) => r.json()).then((r) => { setMissing(!r.signedIn); if (r.signedIn) d(restartAgent()); }).catch((e) => setError(String(e)));
    }}>{t('agentRetry')}</button>
  </span>;
}
