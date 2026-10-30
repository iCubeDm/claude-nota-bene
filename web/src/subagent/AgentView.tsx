import { useEffect } from 'react';
import { useStore } from 'react-redux';
import { useT } from '@/i18n/index.ts';
import { HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { useAppDispatch, useAppSelector, type AppStore } from '@/store/store.ts';
import { setAgentTitle, type AgentTab } from '@/tabs/slice.ts';
import { selectLiveCalls } from '@/tasks/slice.ts';
import { AGENT_PROTOCOL, OLD_SERVER, fetchSubagent, selectSubagent, selectToolResulted } from './slice.ts';

/** How often a running subagent is read again while its tab is the visible one. */
export const POLL_MS = 1500;

/**
 * A subagent's conversation in its own tab: read-only (no composer, no input of any kind), drawn by the same Feed and
 * reducer as the chat. Polling, not streaming (step 1): it is read when the tab opens or is shown, then every POLL_MS
 * while the subagent runs and the tab is the visible one; a finished or hidden tab is not polled. Selections in it are
 * commentable like the chat's (`data-chat-pane` + `data-agent`); the comments go to the main session. A subagent that is
 * not in the current conversation, or a failed read, is said in a line, never an empty pane; both are tried again with a backoff while the tab is visible.
 */
export function AgentView({ tab, active }: { tab: AgentTab; active: boolean }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const store = useStore() as AppStore;
  const session = useAppSelector((s) => s.feed.session?.id ?? null);
  const entry = useAppSelector((s) => selectSubagent(s, tab.tool));
  // protocol 0: no `hello` yet, nothing to claim
  const noComment = useAppSelector((s) => s.controls.protocol > 0 && s.controls.protocol < AGENT_PROTOCOL);
  const { tool } = tab;
  // keep reading only while something says it works: a live task of its call, or the call has no result yet. The
  // server's `running` alone is not enough (a meta without `finished` proves nothing)
  const live = useAppSelector((s) => selectLiveCalls(s).has(tool));
  const resulted = useAppSelector((s) => selectToolResulted(s, tool));
  const pollable = live || !resulted;
  // a server restart (a new `hello`) reads at once: the one before may have been too old for /subagent
  const protocol = useAppSelector((s) => s.controls.protocol);

  useEffect(() => {
    if (!session) return; // the conversation is not known yet: the read waits for it
    // a hidden tab that already has its content is not read again (and so not polled)
    const have = selectSubagent(store.getState(), tool)?.status === 'ok';
    if (!active && have) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0; // a read that failed (or said "not in this session") is tried again, 3 s, 6 s, … up to 30 s: one blip must not freeze a running agent's pane
    const tick = async () => {
      const r = await dispatch(fetchSubagent(tool, ctl.signal));
      if (ctl.signal.aborted) return;
      // `gone` is retried too, finished call or not: the answer was seen to be a transient miss for a subagent that WAS in the
      // session, and a real gone only costs one cheap request per 30 s while its tab is the visible one. `ok` replaces it.
      const again = r === 'gone' || (pollable && (r === 'running' || r === 'error'));
      if (!active || !again) return;
      if (r === 'running') fails = 0;
      else fails = fails ? fails * 2 : POLL_MS * 2;
      timer = setTimeout(() => void tick(), r === 'running' ? POLL_MS : Math.min(30_000, fails));
    };
    void tick();
    return () => {
      ctl.abort();
      clearTimeout(timer);
    };
  }, [tool, session, active, pollable, protocol, dispatch, store]);

  // the real description names the tab (a restored one had the saved title)
  const name = entry?.description || entry?.type || '';
  useEffect(() => {
    if (name) dispatch(setAgentTitle({ tool, title: name }));
  }, [name, tool, dispatch]);

  const ok = entry?.status === 'ok';
  return (
    <main data-chat-pane data-pane={tab.id} data-agent={tool} hidden={!active} className="grid-pane relative min-h-0 flex-1 overflow-auto">
      <div data-items className="nb-card nb-prose px-10 pt-5 pb-7 text-[15px] leading-[1.625] text-foreground/90">
        <div data-anchor-skip data-kind="agent-note" className="mb-3 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>{t('agentReadOnly')}</span>
          {noComment && <span data-agent-nocomment className="text-destructive">· {t('agentNoComment')}</span>}
          {ok && entry.running && <span data-agent-running className="text-nb-accent">· {t('agentRunning')}</span>}
        </div>
        {!entry || entry.status === 'loading' ? (
          <div data-anchor-skip data-kind="agent-status" role="status" className="py-6 text-center text-sm text-muted-foreground">{t('agentLoading')}</div>
        ) : entry.status === 'gone' ? (
          <div data-anchor-skip data-kind="agent-status" role="status" className="py-6 text-center text-sm text-muted-foreground">{t('agentGone')}</div>
        ) : (
          <>
            {entry.status === 'error' && (
              <div data-anchor-skip data-kind="agent-status" role="alert" className="mb-3 rounded border border-destructive/40 px-3 py-2 text-sm text-destructive">{entry.error === OLD_SERVER ? t('agentOldServer') : t('agentFailed', entry.error ?? '')}</div>
            )}
            {entry.feed.items.length > 0 && <Feed feed={entry.feed} agent={tool} running={entry.running} />}
          </>
        )}
      </div>
      <HighlightLayer pane={tab.id} />
    </main>
  );
}
