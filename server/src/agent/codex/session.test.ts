import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent } from '@nota-bene/shared';
import { CodexSession } from './session.ts';
import { codexBackend } from './backend.ts';
import type { CodexConnection } from './controls.ts';

export class Script implements CodexConnection {
  end!: () => void;
  closed = new Promise<void>((r) => { this.end = r; });
  listener = (_m: string, _p: Record<string, unknown>) => {};
  handler: Parameters<CodexConnection['onRequest']>[0] = async () => ({});
  calls: { method: string; params: Record<string, unknown> }[] = [];
  reply = async (method: string, _p: Record<string, unknown>): Promise<unknown> => {
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    if (method.startsWith('thread/') && /start|resume|fork/.test(method)) return { thread: { id: 'new-thread', cwd: '/tmp' }, model: 'gpt', sandbox: { type: 'workspaceWrite' } };
    if (method === 'turn/start') return { turn: { id: 't1' } };
    if (method === 'model/list') return { data: [{ id: 'gpt', model: 'gpt', displayName: 'GPT', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] };
    return {};
  };
  async request(method: string, params: unknown = {}): Promise<unknown> { this.calls.push({ method, params: params as Record<string, unknown> }); return this.reply(method, params as Record<string, unknown>); }
  onNotification(f: typeof this.listener) { this.listener = f; return () => {}; }
  onRequest(f: typeof this.handler) { this.handler = f; }
  async close() { this.end(); }
  emit(m: string, p: Record<string, unknown>) { this.listener(m, { threadId: 'new-thread', ...p }); }
}
const flush = () => new Promise<void>((r) => setTimeout(r, 10));
function setup(rpc = new Script(), extra = {}) {
  const session = new CodexSession({ cwd: '/tmp', permissionMode: 'codex-configured', ask: async () => false, ...extra }, rpc);
  const events: AgentEvent[] = [];
  const reading = (async () => { for await (const e of session.messages) events.push(e); })().catch(() => {});
  return { rpc, session, events, async close() { session.close(); await reading; } };
}
const send = (session: CodexSession, uuid: string, priority: 'next' | 'now' = 'next') => session.send({ uuid, text: uuid, priority });

describe('Codex session ownership', () => {
  it('holds completion until a steering acknowledgement and settles only accepted sends once', async () => {
    const s = setup(); await s.session.ready;
    send(s.session, 'a'); await flush();
    let ack!: (v: unknown) => void;
    const base = s.rpc.reply;
    s.rpc.reply = (m, p) => m === 'turn/steer' ? new Promise((r) => { ack = r; }) : base(m, p);
    send(s.session, 'b'); await flush();
    s.rpc.emit('turn/completed', { turn: { id: 't1', status: 'completed' } });
    expect(s.events.filter((e) => e.t === 'turn-end')).toEqual([]);
    ack({ turnId: 't1' }); await flush();
    expect(s.events.filter((e) => e.t === 'turn-end')).toMatchObject([{ answers: ['a', 'b'], stop: 'done' }]);
    s.rpc.emit('turn/completed', { turn: { id: 't1', status: 'completed' } }); await flush();
    expect(s.events.filter((e) => e.t === 'turn-end')).toHaveLength(1);
    await s.close();
  });
  it('force sends wait for native completion rather than steering the interrupted turn', async () => {
    const s = setup(); await s.session.ready; send(s.session, 'a'); await flush();
    send(s.session, 'b', 'now'); await flush();
    expect(s.rpc.calls.at(-1)?.method).toBe('turn/interrupt');
    expect(s.rpc.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1);
    s.rpc.emit('turn/completed', { turn: { id: 't1', status: 'interrupted' } }); await flush();
    expect(s.rpc.calls.filter((x) => x.method === 'turn/start')).toHaveLength(2);
    expect(s.rpc.calls.some((x) => x.method === 'turn/steer')).toBe(false);
    await s.close();
  });
  it('does not retry a timed out steer as another model turn', async () => {
    const s = setup(); await s.session.ready; send(s.session, 'a'); await flush();
    const base = s.rpc.reply; s.rpc.reply = async (m, p) => { if (m === 'turn/steer') throw new Error('timed out'); return base(m, p); };
    send(s.session, 'b'); await flush();
    expect(s.rpc.calls.filter((x) => x.method === 'turn/start')).toHaveLength(1);
    expect(s.events).toContainEqual(expect.objectContaining({ t: 'turn-end', stop: 'failed', answers: ['b'] }));
    await s.close();
  });
  it('a fork announces the destination, clear creates another native conversation', async () => {
    const s = setup(new Script(), { resume: 'source', fork: true }); await s.session.ready; await flush();
    expect(s.rpc.calls.find((x) => x.method === 'thread/fork')?.params.threadId).toBe('source');
    expect(s.events).toContainEqual(expect.objectContaining({ t: 'init', sessionId: 'new-thread' }));
    s.session.send({ uuid: 'clear', text: '/clear', priority: 'next' }); await flush();
    expect(s.rpc.calls.some((x) => x.method === 'thread/start')).toBe(true);
    expect(s.events).toContainEqual({ t: 'reset', newId: 'new-thread' });
    await s.close();
  });
  it('interrupt aborts a native approval and close ends the iterator', async () => {
    const ask = vi.fn(async (_n, _i, signal: AbortSignal) => new Promise<boolean>((r) => signal.addEventListener('abort', () => r(false), { once: true })));
    const s = setup(new Script(), { ask }); await s.session.ready;
    const answered = s.rpc.handler({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'new-thread', command: 'ls', availableDecisions: ['accept', 'decline'] } }, new AbortController().signal);
    await flush(); await s.session.interrupt();
    expect(await answered).toEqual({ decision: 'decline' });
    await s.close();
  });
  it('missing login fails before thread creation without reading credentials', async () => {
    const rpc = new Script(); rpc.reply = async () => ({ account: null, requiresOpenaiAuth: true });
    const s = setup(rpc); await expect(s.session.ready).rejects.toThrow(/sign in/i); await flush();
    expect(rpc.calls.some((x) => x.method === 'thread/start')).toBe(false);
    await s.close();
  });
});

it('backend uses native metadata, isolates history and closes its metadata connection', async () => {
  const rpc = new Script(); const base = rpc.reply;
  rpc.reply = async (m, p) => m === 'thread/list' ? { data: [{ id: 'one', cwd: '/tmp', name: 'title', updatedAt: 12 }] }
    : m === 'thread/read' ? { thread: { id: 'one', cwd: '/tmp', preview: 'hello' } } : base(m, p);
  const backend = codexBackend({ connect: () => rpc });
  expect(await backend.listSessions()).toMatchObject([{ sessionId: 'one', customTitle: 'title', cwd: '/tmp', lastModified: 12000 }]);
  expect(await backend.sessionInfo('one', '/elsewhere')).toBeNull();
  expect(await backend.sessionInfo('one', '/tmp')).toMatchObject({ cwd: '/tmp', firstPrompt: 'hello' });
  await backend.close?.(); await rpc.closed;
});

it('returning to configured restores the native sandbox after an explicit full-access turn', async () => {
  const rpc = new Script(); const base = rpc.reply;
  rpc.reply = async (m, p) => m === 'thread/start' ? { thread: { id: 'new-thread' }, model: 'gpt', approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } } : base(m, p);
  const s = setup(rpc); await s.session.ready;
  await s.session.setPermissionMode('codex-full-access'); send(s.session, 'unsafe'); await flush();
  expect(rpc.calls.filter((r) => r.method === 'turn/start').at(-1)?.params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
  rpc.emit('turn/completed', { turn: { id: 't1', status: 'completed' } }); await flush();
  await s.session.setPermissionMode('codex-configured'); send(s.session, 'configured'); await flush();
  expect(rpc.calls.filter((r) => r.method === 'turn/start').at(-1)?.params.sandboxPolicy).toEqual({ type: 'readOnly' });
  await s.close();
});
