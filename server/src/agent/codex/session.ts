import path from 'node:path';
import { type AgentEvent, type AgentEffort as EffortLevel, type AgentMode as Mode, type ModelOption, type SlashCommand, type Stats } from '@nota-bene/shared';
import type { ProviderSession as AgentSession, ProviderStartOptions as StartOptions } from '../types.ts';
import { answerNative, CODEX_CAPABILITIES, limits, models, policy, type CodexConnection } from './controls.ts';
import { array, codexInput, CodexMapper, itemId, record, string } from './map.ts';

type Turn = { interruptRequested?: boolean; interruption?: Promise<void>; id?: string; ids: Set<string>; pending: number; end?: Record<string, unknown>; finished: boolean; at: number; done: Promise<void>; resolve(): void };
function turn(): Turn { let resolve!: () => void; const done = new Promise<void>((r) => { resolve = r; }); return { ids: new Set(), pending: 0, finished: false, at: Date.now(), done, resolve }; }

/** One owned native process per active conversation. Acceptance is serial; generation work is not. */
export class CodexSession implements AgentSession {
  readonly ready: Promise<void>;
  readonly messages: AsyncIterable<AgentEvent>;
  private readonly events: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;
  private chain = Promise.resolve();
  private stopGeneration = 0;
  private configuredModel: string | null = null;
  private configuredEffort: EffortLevel | null = null;
  private mapper = new CodexMapper();
  private tid = '';
  private mode: Mode;
  private model: string | null;
  private configuredPolicy: Record<string, unknown> = {};
  private effort: EffortLevel | null;
  private active: Turn | undefined;
  private readonly turns = new Map<string, Turn>();
  private askCtl = new AbortController();
  private context: Stats['context'] = null;
  private windows: Stats['windows'];
  private modelList: ModelOption[] | undefined;
  private skills = new Map<string, string>();
  private readonly children = new Map<string, string>();
  private readonly terminals = new Map<string, { processId: string; itemId: string }>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private readonly o: StartOptions;
  readonly rpc: CodexConnection;
  constructor(o: StartOptions, rpc: CodexConnection) {
    this.o = o; this.rpc = rpc;
    this.mode = o.permissionMode; this.model = o.model ?? null; this.effort = o.effort ?? null;
    this.messages = { [Symbol.asyncIterator]: () => this.read() };
    rpc.onNotification((m, p) => this.notification(m, p));
    rpc.onRequest((r, s) => {
      if (r.params.threadId && r.params.threadId !== this.tid) throw new Error('Request from another Codex thread');
      return answerNative(r, AbortSignal.any([s, this.askCtl.signal]), o);
    });
    this.ready = this.open(o.resume, o.fork).then(() => {
      if (this.ended) return;
      this.timer = setInterval(() => { void this.pollTerminals(); }, 3000); this.timer.unref();
    });
    void this.ready.catch((e) => this.fail(e));
    void rpc.closed.then(() => { if (!this.ended) this.fail(new Error('Codex disconnected. Restart the session to retry.')); });
  }
  private push(e: AgentEvent) { if (!this.ended) { this.events.push(e); this.wake?.(); } }
  private async *read(): AsyncGenerator<AgentEvent> {
    for (;;) {
      if (this.events.length) { yield this.events.shift()!; continue; }
      if (this.ended) { if (this.failure) throw this.failure; return; }
      await new Promise<void>((r) => { this.wake = r; }); this.wake = undefined;
    }
  }
  private fail(e: unknown) { this.failure = e instanceof Error ? e : new Error(String(e)); this.close(); }
  private async open(resume?: string, fork?: boolean): Promise<void> {
    const account = record(await this.rpc.request('account/read', {}));
    if (account.requiresOpenaiAuth === true && !account.account) throw new Error('Codex: sign in to your ChatGPT account (codex login), then restart this session.');
    if (this.model && !(await this.supportedModels()).some((m) => m.value === this.model)) { this.model = null; this.effort = null; }
    const requestedModel = this.model;
    const response = record(await this.rpc.request(resume ? fork ? 'thread/fork' : 'thread/resume' : 'thread/start', {
      developerInstructions: 'You are in Nota Bene, a browser chat rendering GitHub-flavored markdown. Use fenced mermaid or SVG diagrams. Show project images/video/audio with Markdown image syntax and project-relative paths. Reference project files with relative paths in inline code so the viewer can open them. The user may send batched inline comments quoting conversation or file fragments: address every item; uncommented material has no objections.',
      cwd: this.o.cwd, ...(resume ? { threadId: resume } : {}),
    }));
    if (this.ended) return;
    this.configuredPolicy = { ...(response.approvalPolicy ? { approvalPolicy: response.approvalPolicy } : {}), ...(response.sandbox ? { sandboxPolicy: response.sandbox } : {}) };
    const thread = record(response.thread); this.tid = string(thread.id);
    if (!this.tid) throw new Error('Codex did not return a thread id');
    this.configuredModel = string(response.model) || null;
    this.configuredEffort = typeof response.reasoningEffort === 'string' ? response.reasoningEffort as EffortLevel : null;
    this.model = requestedModel ?? this.configuredModel;
    this.push({ t: 'init', sessionId: this.tid, ...(this.model ? { model: this.model } : {}), mode: this.mode });
  }
  send(m: Parameters<AgentSession['send']>[0]): void {
    if (this.ended) return;
    const generation = this.stopGeneration;
    const run = this.chain.then(async () => {
      await this.ready; if (this.ended) return;
      if (generation !== this.stopGeneration) { this.push({ t: 'cancelled', sendId: m.uuid }); return; }
      await this.dispatch(m);
    });
    this.chain = run.catch((e) => { this.push({ t: 'turn-end', stop: 'failed', secs: 0, answers: [m.uuid], queued: 0, error: e instanceof Error ? e.message : String(e) }); });
  }
  private async dispatch(m: Parameters<AgentSession['send']>[0]): Promise<void> {
    if (m.priority === 'now' && this.active) {
      const active = this.active; await this.interruptActive();
      // An interrupt acknowledgement is not completion. Never steer the force-send into that old turn.
      await Promise.race([active.done, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('Codex has not finished interrupting; retry after it stops.')), 30_000); t.unref(); void active.done.then(() => clearTimeout(t)); })]);
      if (this.ended) return;
    }
    if (/^\/clear\s*$/.test(m.text)) {
      if (this.active) throw new Error('Wait for Codex to finish before clearing');
      await this.rpc.request('thread/backgroundTerminals/clean', { threadId: this.tid });
      await this.rpc.request('thread/unsubscribe', { threadId: this.tid });
      this.mapper = new CodexMapper(); this.turns.clear(); this.children.clear(); this.terminals.clear(); this.context = null;
      this.cancelAsks(); await this.open(); this.push({ t: 'reset', newId: this.tid });
      this.push({ t: 'init', sessionId: this.tid, ...(this.model ? { model: this.model } : {}), mode: this.mode });
      this.push({ t: 'turn-end', stop: 'done', secs: 0, answers: [m.uuid], queued: 0 }); return;
    }
    const input = codexInput(m.text, m.images);
    const match = /^\/([^\s]+)(?:\s|$)/.exec(m.text);
    if (match && this.skills.has(match[1]!)) input.push({ type: 'skill', name: match[1], path: this.skills.get(match[1]!) });
    const active = this.active;
    if (active && active.id && !active.end) {
      active.pending++;
      let retry = false;
      try {
        await this.rpc.request('turn/steer', { threadId: this.tid, expectedTurnId: active.id, clientUserMessageId: m.uuid, input });
        active.ids.add(m.uuid);
      } catch (error) {
        if (active.end && /no active turn|turn.*not.*(?:active|running|found)/i.test(error instanceof Error ? error.message : String(error))) retry = true;
        else throw error;
      } finally { active.pending--; this.settle(active); }
      if (retry) await this.dispatch(m);
      return;
    }
    const t = turn(); t.ids.add(m.uuid); this.active = t; t.pending++;
    try {
      if (/^\/compact(?:\s|$)/.test(m.text)) await this.rpc.request('thread/compact/start', { threadId: this.tid });
      else {
        const effort = this.effort ?? (await this.supportedModels()).find((m) => m.value === this.model)?.defaultEffort ?? (this.model === this.configuredModel ? this.configuredEffort : null);
        const response = record(await this.rpc.request('turn/start', { threadId: this.tid, clientUserMessageId: m.uuid, input, ...(this.mode === 'codex-configured' ? this.configuredPolicy : policy(this.mode, this.o.cwd, true)), ...(this.model ? { model: this.model } : {}), ...(effort ? { effort } : {}) }));
        this.bind(t, string(record(response.turn).id));
      }
    } catch (error) { if (this.active === t) this.active = undefined; t.finished = true; t.resolve(); throw error; }
    finally { t.pending--; this.settle(t); }
  }
  private bind(t: Turn, id: string) {
    if (id) { t.id = id; this.turns.set(id, t); if (t.interruptRequested && !t.end) void this.interruptTurn(t).catch((e) => this.fail(e)); }
  }
  private settle(t: Turn) {
    if (!t.end || t.pending || t.finished) return;
    t.finished = true; if (this.active === t) this.active = undefined;
    const status = string(t.end.status), error = string(record(t.end.error).message);
    this.push({ t: 'turn-end', stop: status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'done', secs: (Date.now() - t.at) / 1000, answers: [...t.ids], queued: 0, ...(error ? { error } : {}) });
    t.resolve(); void this.pollTerminals();
  }
  private notification(method: string, p: Record<string, unknown>): void {
    if (this.ended || (p.threadId && p.threadId !== this.tid)) return;
    if (method === 'turn/started') {
      const id = string(record(p.turn).id);
      let t = this.turns.get(id);
      if (!t) { t = this.active && !this.active.id ? this.active : turn(); this.bind(t, id); }
      if (!t.finished) this.active = t;
    }
    if (method === 'turn/completed') {
      const native = record(p.turn), id = string(native.id);
      const t = this.turns.get(id) ?? (this.active && !this.active.id ? this.active : undefined);
      if (t) { this.bind(t, id); t.end = native; this.settle(t); }
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = record(p.tokenUsage), last = record(usage.last), max = usage.modelContextWindow, used = last.totalTokens;
      if (typeof max === 'number' && max > 0 && typeof used === 'number') this.context = { used, max, pct: used / max * 100 };
    }
    if (method === 'account/rateLimits/updated') this.windows = limits(p);
    const item = record(p.item);
    if (item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity') {
      const child = string(item.agentThreadId) || string(array(item.receiverThreadIds)[0]);
      if (child) this.children.set(itemId(string(item.id)), child);
    }
    for (const e of this.mapper.notification(method, p)) this.push(e);
  }
  private cancelAsks() { this.askCtl.abort(); this.askCtl = new AbortController(); }
  async interrupt(): Promise<void> { this.stopGeneration++; await this.interruptActive(); }
  private async interruptActive(): Promise<void> {
    this.cancelAsks();
    const t = this.active;
    if (t && !t.end) { t.interruptRequested = true; if (t.id) await this.interruptTurn(t); }
  }
  private interruptTurn(t: Turn): Promise<void> {
    return t.interruption ??= this.rpc.request('turn/interrupt', { threadId: this.tid, turnId: t.id }).then(() => {}, (e) => { if (!t.end) throw e; });
  }
  get threadId(): string { return this.tid; }
  async setPermissionMode(mode: Mode): Promise<void> { policy(mode, this.o.cwd); this.mode = mode; }
  async supportedModels(): Promise<ModelOption[]> { return this.modelList ??= models(await this.rpc.request('model/list', {})); }
  async setModel(model: string | null): Promise<void> { if (model && !(await this.supportedModels()).some((m) => m.value === model)) throw new Error('Unknown Codex model'); this.model = model ?? this.configuredModel; }
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (effort && !(await this.supportedModels()).find((m) => m.value === this.model)?.efforts?.includes(effort)) throw new Error('Unsupported Codex reasoning effort');
    this.effort = effort;
  }
  async supportedCommands(): Promise<SlashCommand[]> {
    const r = record(await this.rpc.request('skills/list', { cwds: [this.o.cwd] }));
    const out: SlashCommand[] = [{ name: 'compact', description: 'Compact this conversation', builtin: true }, { name: 'clear', description: 'Start a new conversation', builtin: true }];
    for (const row of array(r.data).map(record)) for (const s of array(row.skills).map(record)) {
      if (s.enabled === false || !s.name || !s.path) continue;
      const name = string(s.name); this.skills.set(name, string(s.path)); out.push({ name, description: string(s.shortDescription ?? s.description) });
    }
    return out;
  }
  async fileSuggestions(query: string): Promise<string[]> {
    const r = record(await this.rpc.request('fuzzyFileSearch', { query, roots: [this.o.cwd] }));
    return array(r.files).map(record).map((f) => { const p = string(f.path); return path.isAbsolute(p) ? path.relative(this.o.cwd, p) : p; }).filter((p) => p && !p.startsWith('../') && !path.isAbsolute(p));
  }
  async contextUsage(): Promise<Stats['context']> { return this.context; }
  async usage(): Promise<{ cost: null; limits: null; windows: NonNullable<Stats['windows']> }> {
    this.windows = limits(await this.rpc.request('account/rateLimits/read', {}));
    return { cost: null, limits: null, windows: this.windows };
  }
  private async pollTerminals() {
    if (!this.tid || this.ended || this.polling) return;
    this.polling = true;
    try {
      const current = new Map<string, { processId: string; itemId: string }>(); let cursor: string | undefined; const seen = new Set<string>();
      do {
        const r = record(await this.rpc.request('thread/backgroundTerminals/list', { threadId: this.tid, ...(cursor ? { cursor } : {}) }));
        for (const p of array(r.data).map(record)) {
          const id = itemId('terminal-' + string(p.processId)); current.set(id, { processId: string(p.processId), itemId: string(p.itemId) });
          if (!this.terminals.has(id)) this.push({ t: 'task', phase: 'started', id, type: 'shell', call: itemId(string(p.itemId)), desc: string(p.command), bg: true });
        }
        cursor = string(r.nextCursor); if (cursor && seen.has(cursor)) throw new Error('Invalid terminal cursor'); seen.add(cursor);
      } while (cursor);
      if (this.ended) return;
      for (const id of this.terminals.keys()) if (!current.has(id)) this.push({ t: 'task', phase: 'done', id });
      this.terminals.clear(); for (const [id, p] of current) this.terminals.set(id, p);
    } catch { /* Native terminal discovery is experimental. Never fabricate tasks when unavailable. */ }
    finally { this.polling = false; }
  }
  async stopTask(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (terminal) { await this.rpc.request('thread/backgroundTerminals/terminate', { threadId: this.tid, processId: terminal.processId }); this.push({ t: 'task', phase: 'done', id, status: 'stopped' }); this.terminals.delete(id); return; }
    const child = [...this.children.values()].find((v) => itemId(v) === id);
    if (!child) throw new Error('Unknown Codex task');
    const r = record(await this.rpc.request('thread/read', { threadId: child, includeTurns: true }));
    const running = array(record(r.thread).turns).map(record).find((t) => t.status === 'inProgress');
    if (!running) throw new Error('No running turn in this Codex child');
    await this.rpc.request('turn/interrupt', { threadId: child, turnId: running.id });
  }
  async backgroundTask(): Promise<boolean> { throw new Error('Codex app-server has no supported foreground-to-background operation'); }
  async taskOutput(): Promise<never> { throw new Error('Codex app-server does not expose a background terminal output tail'); }
  childFor(call: string): string | undefined { return this.children.get(call); }
  close(): void {
    if (this.ended) return; this.ended = true; clearInterval(this.timer); this.askCtl.abort();
    for (const t of this.turns.values()) t.resolve(); this.active?.resolve();
    this.wake?.(); void this.rpc.close();
  }
}
