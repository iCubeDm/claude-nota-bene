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
};

type Msg = { type?: string; subtype?: string; session_id?: string };

export async function createSessionManager(o: { hub: EventHub; backend: AgentBackend; cwd: string; resume?: string }): Promise<SessionManager> {
  const { hub, backend, cwd } = o;
  let sessionId: string | null = o.resume ?? null;
  let agent: AgentSession | null = null;
  let chain: Promise<void> = Promise.resolve(); // keeps interrupt-then-send ordering across sends
  const pending = new Map<string, (allow: boolean) => void>();

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
        if (type === 'system' && subtype === 'init' && session_id) {
          sessionId = session_id;
          saveSession(cwd, session_id);
          hub.emit({ kind: 'session', id: session_id, root: cwd });
        }
      }
      if (agent === a) died(a, new Error('agent session ended'));
    } catch (e) {
      if (agent === a) died(a, e);
    }
  }

  function died(a: AgentSession, e: unknown): void {
    reportError(hub, 'agent', e);
    agent = null;
    try { a.close(); } catch (err) { reportError(hub, 'agent-close', err); }
    for (const finish of [...pending.values()]) finish(false);
    const message = e instanceof Error ? e.message : String(e);
    hub.emit({
      kind: 'sdk',
      m: { type: 'result', subtype: 'error_during_execution', is_error: true, result: message } as unknown as SDKMessage,
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
  }
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
  };
}
