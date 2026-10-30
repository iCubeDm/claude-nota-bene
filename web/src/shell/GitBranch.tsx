import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/index.ts';
import { selectSession, selectTurnSeq, useAppSelector } from '@/store/store.ts';
import { apiFetch } from '@/net/auth.ts';

type GitStatus = { branch: string | null; detached: boolean; dirty: boolean };
const THROTTLE = 3_000;

const isStatus = (v: unknown): v is GitStatus => {
  const s = v as GitStatus;
  return !!s && typeof s.dirty === 'boolean' && typeof s.detached === 'boolean' && (s.branch === null || typeof s.branch === 'string');
};

/**
 * GET /git-status for the current root: on load, on a root change, after each live turn and on window focus, at most
 * one request per 3 s (a request inside the window is deferred to its end, not dropped). null: not a repo / no answer.
 */
function useGitStatus(root: string | undefined, turnSeq: number): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRef<() => void>(() => {});
  const gen = useRef(0); // a root change drops the answer of the previous root
  useEffect(() => {
    if (!root) { setStatus(null); return; }
    const mine = ++gen.current;
    setStatus(null);
    const fetchNow = async () => {
      last.current = Date.now();
      try {
        const r = await apiFetch('/git-status');
        if (!r.ok) return; // git timed out (503): keep what is shown
        const v: unknown = await r.json();
        if (mine === gen.current) setStatus(isStatus(v) ? v : null);
      } catch {
        // offline: keep what is shown
      }
    };
    run.current = () => {
      if (timer.current) return; // one is already scheduled
      const wait = last.current + THROTTLE - Date.now();
      if (wait <= 0) void fetchNow();
      else timer.current = setTimeout(() => { timer.current = null; void fetchNow(); }, wait);
    };
    last.current = 0; // a new root is asked at once
    run.current();
    const onFocus = () => run.current();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      gen.current++;
    };
  }, [root]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    run.current();
  }, [turnSeq]);
  return status;
}

/** `(main ✔)` / `(feature/x ✗)` after the project path, like the shell prompt; nothing outside a repo. */
export function GitBranch() {
  const t = useT();
  const root = useAppSelector(selectSession)?.root;
  const st = useGitStatus(root, useAppSelector(selectTurnSeq));
  if (!st) return null;
  return (
    <span id="git-branch" title={`${t('gitBranch')} · ${st.dirty ? t('gitDirty') : t('gitClean')}`} className="flex-none whitespace-nowrap font-mono text-[11px] opacity-80">
      ({st.detached ? t('gitDetached') : st.branch}{' '}
      {st.dirty ? <span data-dirty className="text-nb-accent/80">✗</span> : <span className="text-success/80">✔</span>})
    </span>
  );
}
