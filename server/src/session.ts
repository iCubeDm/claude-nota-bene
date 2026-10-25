import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ImageRef } from '@nota-bene/shared';
import { AttachmentStore } from './attachments.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, AgentSession, PermissionAsk, SendImage } from './agent/types.ts';
import { stripUserFrameImages } from './agent/transcript.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { saveSession, stateDir } from './state.ts';

export type SessionManager = {
  send(m: { id: string; text: string; force?: boolean; images?: ImageRef[] }): void;
  interrupt(): void;
  answer(permissionId: string, allow: boolean): void;
  info(): { id: string | null; root: string };
  /** Called whenever the session id changes to a real id (first init, or a different id after resume/restart). */
  onSessionId(cb: (id: string, prev: string | null) => void): void;
};

type Msg = { type?: string; subtype?: string; session_id?: string };

export async function createSessionManager(o: { hub: EventHub; backend: AgentBackend; cwd: string; resume?: string; attachments?: AttachmentStore }): Promise<SessionManager> {
  const { hub, backend, cwd } = o;
  const attachments = o.attachments ?? new AttachmentStore({ dir: path.join(stateDir(), 'attachments') });
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
        hub.emit({ kind: 'sdk', m: stripUserFrameImages(m) });
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
      history = await backend.history(o.resume, cwd, attachments, (e) => reportError(hub, 'attach', e));
    } catch (e) {
      reportError(hub, 'history', e); // an unreadable transcript must not stop the server: start with an empty feed
    }
    hub.reset(history);
    hub.emit({ kind: 'resumed', id: o.resume });
  }
  announce(sessionId); // header gets the root (and a resumed id) before the first turn's init
  ensureAgent();

  return {
    send({ id, text, force, images }) {
      ensureAgent();
      // resolve refs first: an unknown id is reported, the text and the other images still go out
      const refs: ImageRef[] = [];
      const payload: SendImage[] = [];
      for (const ref of images ?? []) {
        try {
          const found = attachments.get(ref.id);
          if (!found) throw new Error(`unknown attachment ${ref.id}`);
          refs.push({ ...ref, mediaType: found.mediaType });
          payload.push({ mediaType: found.mediaType, data: found.bytes.toString('base64'), label: ref.label });
        } catch (e) {
          reportError(hub, 'attach', e);
        }
      }
      hub.emit({ kind: 'user', id, text, ...(force ? { force: true } : {}), ...(refs.length ? { images: refs } : {}) });
      chain = chain.then(async () => {
        try {
          // resolve the agent when this runs: a crash while queued restarts it
          if (force) await ensureAgent().interrupt().catch((e) => reportError(hub, 'interrupt', e)); // no-op when idle
          ensureAgent().send({ uuid: id, text, priority: force ? 'now' : 'next', ...(payload.length ? { images: payload } : {}) });
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
