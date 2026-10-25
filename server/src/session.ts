import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, AgentSession, PermissionAsk } from './agent/types.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { saveSession } from './state.ts';

export type SessionManager = {
  send(m: { id: string; text: string; force?: boolean }): void;
  interrupt(): void;
  answer(permissionId: string, allow: boolean): void;
  info(): { id: string | null; root: string };
  /** Called whenever the session id changes to a real id (first init, or a different id after resume/restart). */
  onSessionId(cb: (id: string, prev: string | null) => void): void;
};

type Msg = { type?: string; subtype?: string; session_id?: string };

export async function createSessionManager(o: { hub: EventHub; backend: AgentBackend; cwd: string; resume?: string }): Promise<SessionManager> {
  const { hub, backend, cwd } = o;
  let sessionId: string | null = o.resume ?? null;
  let announced: string | null | undefined; // last id sent as a `session` event
  let saved: string | null = null; // last id written to the registry
  let agent: AgentSession | null = null;
  let chain: Promise<void> = Promise.resolve(); // keeps interrupt-then-send ordering across sends
  const pending = new Map<string, (allow: boolean) => void>();
  const idListeners: ((id: string, prev: string | null) => void)[] = [];

  const ask: PermissionAsk = (toolName, input, signal) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const finish = (allow: boolean) => {
        if (!pending.delete(id)) return;
        signal.removeEventListener('abort', onAbort);
        hub.emit({ kind: 'permission-done', id, allow });
        resolve(allow);
      };
      const onAbort = () => finish(false);
      pending.set(id, finish);
      signal.addEventListener('abort', onAbort, { once: true });
      hub.emit({ kind: 'permission', id, toolName, input });
      if (signal.aborted) onAbort();
    });

  async function pump(a: AgentSession): Promise<void> {
    try {
      for await (const m of a.messages) {
        if (agent !== a) return;
        hub.emit({ kind: 'sdk', m });
        const { type, subtype, session_id } = m as Msg;
        // the CLI sends init at the start of every turn: act only when the id is new
        if (type === 'system' && subtype === 'init' && session_id) {
          sessionId = session_id;
          if (saved !== session_id) { saved = session_id; saveSession(cwd, session_id); }
          announce(session_id);
        }
      }
      if (agent === a) died(a, new Error('agent session ended'));
    } catch (e) {
      if (agent === a) died(a, e);
    }
  }

  function announce(id: string | null): void {
    if (id === announced) return;
    const prev = announced ?? null;
    announced = id;
    hub.emit({ kind: 'session', id, root: cwd });
    if (id !== null) {
      for (const cb of idListeners) {
        try { cb(id, prev); } catch (e) { reportError(hub, 'session-id', e); }
      }
    }
  }

  function died(a: AgentSession, e: unknown): void {
    reportError(hub, 'agent', e);
    agent = null;
    try { a.close(); } catch (err) { reportError(hub, 'agent-close', err); }
    for (const finish of [...pending.values()]) finish(false);
    emitErrorResult(e);
  }

  // shaped like SDKResultError: the text goes in errors[]; no aborted terminal_reason, so it shows as an error.
  // With `answers` it names the send it stands in for (user_message_uuid(s)); without, it answers every waiting send.
  function emitErrorResult(e: unknown, answers?: string): void {
    const message = e instanceof Error ? e.message : String(e);
    hub.emit({
      kind: 'sdk',
      m: {
        type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, errors: [message],
        ...(answers ? { user_message_uuid: answers, user_message_uuids: [answers] } : {}),
      } as unknown as SDKMessage,
    });
  }

  function ensureAgent(): AgentSession {
    if (agent) return agent;
    const a = backend.start({ cwd, ...(sessionId ? { resume: sessionId } : {}), ask });
    agent = a;
    void pump(a);
    return a;
  }

  if (o.resume) {
    let history: Awaited<ReturnType<AgentBackend['history']>> = [];
    try {
      history = await backend.history(o.resume, cwd);
    } catch (e) {
      reportError(hub, 'history', e); // an unreadable transcript must not stop the server: start with an empty feed
    }
    hub.reset(history);
    hub.emit({ kind: 'resumed', id: o.resume });
  }
  announce(sessionId); // header gets the root (and a resumed id) before the first turn's init
  ensureAgent();

  return {
    send({ id, text, force }) {
      ensureAgent();
      hub.emit({ kind: 'user', id, text, ...(force ? { force: true } : {}) });
      chain = chain.then(async () => {
        try {
          // resolve the agent when this runs: a crash while queued restarts it
          if (force) await ensureAgent().interrupt().catch((e) => reportError(hub, 'interrupt', e)); // no-op when idle
          ensureAgent().send({ uuid: id, text, priority: force ? 'now' : 'next' });
        } catch (e) {
          reportError(hub, 'send', e);
          emitErrorResult(e, id); // the user event is already out: answer it or the feed waits forever
        }
      });
    },
    interrupt() {
      agent?.interrupt().catch((e) => reportError(hub, 'interrupt', e));
    },
    answer(permissionId, allow) {
      pending.get(permissionId)?.(allow);
    },
    info: () => ({ id: sessionId, root: cwd }),
    onSessionId(cb) {
      idListeners.push(cb);
    },
  };
}
