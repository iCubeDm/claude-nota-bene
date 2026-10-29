import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_CAPABILITIES, type AgentEvent, type Capabilities, type EffortLevel, type Mode, type ModelOption, type ServerEvent, type Stats } from '@nota-bene/shared';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { isWire, mapFrames, mapSdk, type SDKMessage } from './claude/map.ts';
import { transcriptToEvents } from './claude/transcript.ts';
import type { AgentBackend, AgentSession, PermissionAsk } from './types.ts';

export type FakeTurn = {
  text: string;
  chunk?: number;
  delayMs?: number;
  /** `output` becomes the tool_result the CLI would stream back (default empty) */
  tools?: { /** default `fake-tool-<turn>-<k>`; a script names it to point a subagent at the call */ id?: string; name: string; input: Record<string, unknown>; output?: string; isError?: boolean }[];
  /** `onAllow`: the `permissionMode` the CLI drops to once this is allowed (a `status` frame), e.g. 'default' after ExitPlanMode */
  ask?: { toolName: string; input: Record<string, unknown>; onAllow?: Mode };
  crash?: boolean;
  /** the reply text then ends with `images: <n>`, the number of images this turn received */
  echoImages?: boolean;
  /** what `fileSuggestions` returns (default none) */
  suggestions?: string[];
  /** the `permissionMode` this turn's init frame carries (the CLI changing the mode on its own); default none */
  initMode?: Mode;
  /** what `contextUsage` returns once this turn has run (default: empty window); the e2e uses a high pct for the hot meter */
  context?: { used: number; max: number; pct: number };
  /** what `usage` returns once this turn has run (default: no cost, no plan limits) */
  usage?: { cost: number | null; limits: Stats['limits'] };
  /** the `model` this turn's init frame carries (default none) */
  model?: string;
  /** `compact_metadata.pre_tokens` of the boundary a `/compact` emits (read from the first turn that sets it; default 12000) */
  compactPreTokens?: number;
  /** how long a `/compact` runs between its `status: compacting` and `status: null` frames (first turn that sets it; default 0) */
  compactMs?: number;
  /** a `/compact` fails: status null with compact_result failed and this error, no boundary (first turn that sets it) */
  compactError?: string;
  /** runs for a prompt containing this text, whatever turn the sequence is at, and does not use up the sequence */
  match?: string;
  /** raw SDK frames sent right after init (session_id is filled in); `{ sleepMs }` only waits (the turn stays busy) */
  frames?: (Record<string, unknown> | { sleepMs: number })[];
  /** a `prompt_suggestion` frame sent after the result, as the SDK does */
  suggestion?: string;
};

/**
 * A scripted entry of the session list. `cwd` may be relative (to the fake's `base`, the project dir) so that an e2e
 * script can name a sibling folder of its temp project; '' means "no cwd" (the list drops it). `history` is what a
 * resume of this id replays.
 */
export type FakeSessionScript = {
  id: string;
  cwd: string;
  customTitle?: string;
  summary?: string;
  firstPrompt?: string;
  lastModified?: number;
  fileSize?: number;
  history?: { role: 'user' | 'assistant'; text: string }[];
};

/**
 * A scripted subagent, found by the tool-use id of the Agent call that started it (any session). Its `messages` become the
 * transcript the real backend would read (a user prompt, assistant texts and tool calls with their results) and go through
 * the same `transcriptToEvents`. `running`: it has not ended (default false).
 */
export type FakeSubagent = {
  toolUseId: string; type?: string; description: string; running?: boolean;
  messages: { role: 'user' | 'assistant'; text?: string; tools?: { id?: string; name: string; input: Record<string, unknown>; output?: string; isError?: boolean }[] }[];
};

function subagentMessages(a: FakeSubagent): SessionMessage[] {
  const out: Record<string, unknown>[] = [];
  a.messages.forEach((m, i) => {
    const base = { parent_tool_use_id: a.toolUseId, session_id: 'fake' };
    if (m.role === 'user') return void out.push({ ...base, type: 'user', uuid: `${a.toolUseId}-m${i}`, message: { role: 'user', content: m.text ?? '' } });
    const tools = (m.tools ?? []).map((t, k) => ({ ...t, id: t.id ?? `${a.toolUseId}-t${i}-${k}` }));
    out.push({
      ...base, type: 'assistant', uuid: `${a.toolUseId}-m${i}`,
      message: { role: 'assistant', content: [...(m.text ? [{ type: 'text', text: m.text }] : []), ...tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))] },
    });
    if (tools.length) {
      out.push({
        ...base, type: 'user', uuid: `${a.toolUseId}-r${i}`,
        message: { role: 'user', content: tools.map((t) => ({ type: 'tool_result', tool_use_id: t.id, content: t.output ?? '', ...(t.isError ? { is_error: true } : {}) })) },
      });
    }
  });
  return out as unknown as SessionMessage[];
}

/**
 * A scripted shell / Monitor task, found by its task id (the `task_started` frame a turn's `frames` sends names it).
 * `chunks` are the output a reader sees growing: each `taskOutput` read reveals one more (a stopped task stops growing).
 */
export type FakeShell = { taskId: string; chunks: string[] };

/** What the fake knows of tasks, shared by its sessions: the scripted shells, how far each was read, and what was asked. */
type TaskState = {
  shells: FakeShell[]; reads: Map<string, number>; stopped: Set<string>; stops: string[]; backgrounds: string[];
  /** what `backgroundTask` answers: true (default), false (nothing matched) or 'throw' (background tasks disabled) */
  background: boolean | 'throw';
  /** task ids `stopTask` refuses (rejects) */ refuseStop: string[];
};

const TAIL_BYTES = 8192;

/** A --fake script: the turns alone (the M0-M3 format), or the turns and a session list. */
export type FakeScript = FakeTurn[] | {
  turns: FakeTurn[]; sessions?: FakeSessionScript[]; historyDelayMs?: number;
  /** what the fake agent can do; default: Claude's full set */ capabilities?: Partial<Capabilities>;
  /** the models it offers (default none); with any, every init reports the running one (the first until one is picked) */
  models?: ModelOption[];
  /** the subagents the Agent calls of the script started (`GET /subagent`) */
  subagents?: FakeSubagent[];
  /** the shell / Monitor tasks of the script (`GET /task-output`) */
  shells?: FakeShell[];
  /** what `backgroundTask` answers (default true) */
  background?: boolean | 'throw';
  /** task ids `stopTask` refuses */
  refuseStop?: string[];
};

/** What a fake agent knows of its model: the list, the one running, and what was asked of it (shared by the backend's tests). */
type ModelState = { options: ModelOption[]; running?: string; sets: (string | null)[]; efforts: (EffortLevel | null)[] };

/**
 * The fake fills only the fields later code reads (type, subtype, session_id, uuid,
 * parent_tool_use_id, message.content, event, duration_ms, is_error, result, terminal_reason,
 * queued_turn_count, user_message_uuid(s)), with the values the real CLI uses (server/test/fixtures/real-frames.json).
 * The rest of the real SDK shape is deliberately not invented, so the objects are cast once, here. They reach the
 * server through the Claude mapper (R-M7-13), so the scripts and the real-frames fixture keep testing the real shapes.
 */
function sdk(m: Record<string, unknown>): SDKMessage {
  return m as unknown as SDKMessage;
}

const DEFAULT_SESSION_ID = 'fake-session';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** The fake's session; `frames` is the raw SDK stream behind `messages` (for its own tests: each iteration is a new run). */
export type FakeAgentSession = AgentSession & { readonly frames: AsyncIterable<SDKMessage> };

class FakeSession implements FakeAgentSession {
  readonly messages: AsyncIterable<AgentEvent>;
  readonly frames: AsyncIterable<SDKMessage>;
  private pending: { uuid: string; text: string; images: number; command?: 'compact' | 'clear' }[] = []; // sends not yet started
  private wake: (() => void) | null = null;
  private closed = false;
  private turnCtl: AbortController | null = null; // set only while a turn runs
  private turnNo = 0;
  private lastTurn: FakeTurn | undefined; // the turn that ran last (its context and usage are what the stats read)
  private readonly turns: FakeTurn[];
  private readonly ask: PermissionAsk;
  private readonly modes: Mode[];
  private readonly mdl: ModelState;
  private sessionId: string; // a /clear replaces it

  private readonly tasks: TaskState;
  private injected: SDKMessage[] = []; // frames outside a turn (a task's end); sent as soon as the stream is idle

  constructor(turns: FakeTurn[], ask: PermissionAsk, modes: Mode[], mdl: ModelState, tasks: TaskState, resume?: string, fork?: boolean) {
    this.turns = turns;
    this.tasks = tasks;
    this.mdl = mdl;
    this.modes = modes;
    this.ask = ask;
    // a resumed CLI session keeps its id; a fork gets a new one
    this.sessionId = resume && fork ? `${resume}-fork-${++forkCount}` : (resume ?? DEFAULT_SESSION_ID);
    this.frames = { [Symbol.asyncIterator]: () => this.run() };
    this.messages = { [Symbol.asyncIterator]: () => mapFrames(this.frames) };
  }

  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: unknown[] }): void {
    if (this.closed) return;
    // like the CLI, the plain string `/compact` or `/clear` is a command, not a prompt
    const command = m.text === '/compact' ? 'compact' : m.text === '/clear' ? 'clear' : undefined;
    this.pending.push({ uuid: m.uuid, text: m.text, images: m.images?.length ?? 0, ...(command ? { command } : {}) });
    this.wake?.();
  }

  async interrupt(): Promise<void> {
    this.turnCtl?.abort();
  }

  async stopTask(taskId: string): Promise<void> {
    this.tasks.stops.push(taskId);
    if (this.tasks.refuseStop.includes(taskId)) throw new Error(`cannot stop ${taskId}: no such task`);
    this.tasks.stopped.add(taskId); // its output stops growing; a task id started again is stopped again by a new stopTask
    // as the CLI does: a task_notification with status stopped
    this.injected.push(sdk({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'stopped', output_file: '', summary: 'stopped', session_id: this.sessionId, uuid: `fake-tn-${taskId}` }));
    this.wake?.();
  }

  async backgroundTask(toolUseId: string): Promise<boolean> {
    this.tasks.backgrounds.push(toolUseId);
    if (this.tasks.background === 'throw') throw new Error('background tasks are disabled');
    return this.tasks.background;
  }

  async taskOutput(taskId: string): Promise<{ output: string; totalBytes: number; truncated: boolean }> {
    const sh = this.tasks.shells.find((x) => x.taskId === taskId);
    if (!sh) throw new Error(`no shell task ${taskId}`);
    const n = this.tasks.reads.get(taskId) ?? 0;
    if (!this.tasks.stopped.has(taskId)) this.tasks.reads.set(taskId, n + 1);
    const bytes = Buffer.from(sh.chunks.slice(0, n + 1).join(''), 'utf8');
    const tail = bytes.length > TAIL_BYTES ? bytes.subarray(bytes.length - TAIL_BYTES) : bytes;
    return { output: tail.toString('utf8'), totalBytes: bytes.length, truncated: bytes.length > TAIL_BYTES };
  }

  async setPermissionMode(mode: Mode): Promise<void> {
    this.modes.push(mode);
  }

  async supportedModels(): Promise<ModelOption[]> {
    return this.mdl.options;
  }

  async setModel(model: string | null): Promise<void> {
    this.mdl.sets.push(model);
    this.mdl.running = model ?? undefined;
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.mdl.efforts.push(effort);
  }

  /** the id an init reports, as the CLI does: the resolved id of the row picked (else of the first, the default) */
  private reportedModel(t: FakeTurn): string | undefined {
    if (t.model) return t.model;
    const o = this.mdl.options.find((x) => x.value === this.mdl.running || x.resolved === this.mdl.running) ?? this.mdl.options[0];
    return this.mdl.running && !o ? this.mdl.running : o && (o.resolved ?? o.value);
  }

  async fileSuggestions(): Promise<string[]> {
    return this.turns.find((t) => t.suggestions)?.suggestions ?? [];
  }

  /** the scripted values of the turn that ran last (the first turn's before any ran) */
  private scripted(): FakeTurn | undefined {
    return this.lastTurn ?? this.turns.find((t) => !t.match);
  }

  /** a turn whose `match` is in the prompt, else the next of the sequence (the turns without `match`) */
  private pick(text: string): FakeTurn {
    const matched = this.turns.find((t) => t.match !== undefined && text.includes(t.match));
    if (matched) return matched;
    const seq = this.turns.filter((t) => t.match === undefined);
    return seq[Math.min(this.turnNo, seq.length - 1)] ?? { text: '' };
  }

  async contextUsage(): Promise<{ used: number; max: number; pct: number }> {
    return this.scripted()?.context ?? { used: 0, max: 200000, pct: 0 };
  }

  async usage(): Promise<{ cost: number | null; limits: Stats['limits'] }> {
    return this.scripted()?.usage ?? { cost: null, limits: null };
  }

  close(): void {
    this.closed = true;
    this.turnCtl?.abort();
    this.wake?.();
  }

  private async *run(): AsyncGenerator<SDKMessage> {
    while (true) {
      while (this.pending.length === 0 && !this.closed) {
        while (this.injected.length) yield this.injected.shift()!;
        if (this.pending.length || this.closed) break;
        await new Promise<void>((r) => { this.wake = r; });
        this.wake = null;
      }
      if (this.closed) return;
      const { uuid, text, images, command } = this.pending.shift()!;
      if (command) {
        yield* this.command(command, uuid);
        continue;
      }
      const base = this.pick(text);
      this.lastTurn = base;
      yield* this.turn(base.echoImages ? { ...base, text: `${base.text}${base.text ? '\n' : ''}images: ${images}` } : base, uuid);
      if (this.closed) return;
    }
  }

  /** Shaped like SDKCompactBoundaryMessage / SDKConversationResetMessage (the latter has a top-level type). */
  private async *command(name: 'compact' | 'clear', sendUuid: string): AsyncGenerator<SDKMessage> {
    const n = ++this.turnNo;
    if (name === 'compact') {
      // as the real CLI does (probed 2026-10-26): status compacting, status null + compact_result, then the boundary
      const ms = this.turns.find((t) => t.compactMs !== undefined)?.compactMs ?? 0;
      yield sdk({ type: 'system', subtype: 'status', status: 'compacting', session_id: this.sessionId, uuid: `fake-cs-${n}` });
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      if (this.closed) return;
      const error = this.turns.find((t) => t.compactError !== undefined)?.compactError;
      yield sdk({
        type: 'system', subtype: 'status', status: null, compact_result: error === undefined ? 'success' : 'failed',
        ...(error === undefined ? {} : { compact_error: error }), session_id: this.sessionId, uuid: `fake-ce-${n}`,
      });
      if (error === undefined) yield sdk({
        type: 'system', subtype: 'compact_boundary', session_id: this.sessionId, uuid: `fake-cb-${n}`,
        compact_metadata: {
          trigger: 'manual', pre_tokens: this.turns.find((t) => t.compactPreTokens !== undefined)?.compactPreTokens ?? 12000,
          duration_ms: Math.max(ms, 1),
        },
      });
      yield sdk({
        type: 'result', subtype: 'success', session_id: this.sessionId, uuid: `fake-r-${n}`, duration_ms: 0, is_error: false,
        result: '', terminal_reason: 'completed', queued_turn_count: 0, user_message_uuid: sendUuid, user_message_uuids: [sendUuid],
      });
      return;
    }
    // /clear: a new conversation, announced by its reset and an init, then a result, as the real CLI does
    this.sessionId = randomUUID();
    yield sdk({
      type: 'conversation_reset', new_conversation_id: this.sessionId, session_id: this.sessionId, uuid: `fake-cr-${n}`,
      trigger: 'clear', user_message_uuid: sendUuid,
    });
    yield sdk({ type: 'system', subtype: 'init', session_id: this.sessionId, uuid: `fake-init-${n}` });
    yield sdk({
      type: 'result', subtype: 'success', session_id: this.sessionId, uuid: `fake-r-${n}`, duration_ms: 0, is_error: false,
      result: '', terminal_reason: 'completed', queued_turn_count: 0, user_message_uuid: sendUuid, user_message_uuids: [sendUuid],
    });
  }

  private async *turn(t: FakeTurn, sendUuid: string): AsyncGenerator<SDKMessage> {
    const n = ++this.turnNo;
    const started = Date.now();
    const ctl = (this.turnCtl = new AbortController());
    let inTools = false;
    try {
      // like the CLI: init at the start of every turn
      yield sdk({
        type: 'system', subtype: 'init', session_id: this.sessionId, uuid: `fake-init-${n}`,
        ...(t.initMode ? { permissionMode: t.initMode } : {}), ...(this.reportedModel(t) ? { model: this.reportedModel(t) } : {}),
      });
      let k = 0;
      for (const f of t.frames ?? []) {
        if ('sleepMs' in f) await sleep(f.sleepMs as number, ctl.signal);
        else yield sdk({ session_id: this.sessionId, uuid: `fake-f-${n}-${k++}`, ...f });
      }
      const size = Math.max(1, t.chunk ?? 8);
      yield sdk({
        type: 'stream_event', session_id: this.sessionId, uuid: `fake-s-${n}-0`, parent_tool_use_id: null,
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      });
      for (let i = 0; i < t.text.length && !ctl.signal.aborted; i += size) {
        await sleep(t.delayMs ?? 0, ctl.signal);
        if (ctl.signal.aborted) break;
        yield sdk({
          type: 'stream_event', session_id: this.sessionId, uuid: `fake-s-${n}-${i / size + 1}`, parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t.text.slice(i, i + size) } },
        });
        if (t.crash) throw new Error('fake backend crash');
      }
      if (t.crash && !ctl.signal.aborted) throw new Error('fake backend crash');
      if (!ctl.signal.aborted) {
        yield sdk({
          type: 'assistant', session_id: this.sessionId, uuid: `fake-a-${n}`, parent_tool_use_id: null,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: t.text },
              ...(t.tools ?? []).map((tool, k) => ({ type: 'tool_use', id: tool.id ?? `fake-tool-${n}-${k}`, name: tool.name, input: tool.input })),
            ],
          },
        });
        if (t.tools?.length) {
          yield sdk({
            type: 'user', session_id: this.sessionId, uuid: `fake-u-${n}`, parent_tool_use_id: null,
            message: {
              role: 'user',
              content: t.tools.map((tool, k) => ({
                type: 'tool_result', tool_use_id: tool.id ?? `fake-tool-${n}-${k}`, content: tool.output ?? '',
                ...(tool.isError ? { is_error: true } : {}),
              })),
            },
          });
        }
        if (t.ask) {
          inTools = true;
          const allowed = await Promise.race([this.ask(t.ask.toolName, t.ask.input, ctl.signal), whenAborted(ctl.signal)]);
          if (allowed === true && t.ask.onAllow) {
            yield sdk({ type: 'system', subtype: 'status', status: null, permissionMode: t.ask.onAllow, session_id: this.sessionId, uuid: `fake-st-${n}` });
          }
        }
      }
      if (this.closed) return;
      const interrupted = ctl.signal.aborted;
      // like the CLI: an interrupt still ends with subtype success; terminal_reason says why
      yield sdk({
        type: 'result',
        subtype: 'success',
        session_id: this.sessionId,
        uuid: `fake-r-${n}`,
        duration_ms: Date.now() - started,
        is_error: false,
        result: interrupted ? '' : t.text,
        terminal_reason: interrupted ? (inTools ? 'aborted_tools' : 'aborted_streaming') : 'completed',
        // sends that arrived during this turn run next, each as its own turn; the real CLI was seen reporting
        // 0 here even then, so the fake does too and the UI must rely on user_message_uuids
        queued_turn_count: 0,
        user_message_uuid: sendUuid,
        user_message_uuids: [sendUuid],
      });
      if (t.suggestion) yield sdk({ type: 'prompt_suggestion', suggestion: t.suggestion, session_id: this.sessionId, uuid: `fake-ps-${n}` });
    } finally {
      this.turnCtl = null;
    }
  }
}

let forkCount = 0;

type Started = { cwd: string; permissionMode: Mode; resume?: string; fork?: boolean; model?: string; effort?: EffortLevel };

/**
 * `startModes` records the mode each agent started with, `setModes` every setPermissionMode call, `starts` every
 * start's cwd, mode and resume id. `sessions` scripts listSessions / sessionInfo / history; `base` resolves their
 * relative cwds.
 */
export function fakeBackend(
  turns: FakeTurn[],
  o: { sessions?: FakeSessionScript[]; base?: string; historyDelayMs?: number; capabilities?: Partial<Capabilities>; models?: ModelOption[]; subagents?: FakeSubagent[]; shells?: FakeShell[]; background?: boolean | 'throw'; refuseStop?: string[] } = {},
): Omit<AgentBackend, 'start'> & {
  start: (o: Parameters<AgentBackend['start']>[0]) => FakeAgentSession; startModes: Mode[]; setModes: Mode[]; starts: Started[];
  /** every setModel / setEffort call, in order */
  setModels: (string | null)[]; setEfforts: (EffortLevel | null)[];
  /** every stopTask / backgroundTask call, in order */
  stops: string[]; backgrounds: string[];
} {
  const tasks: TaskState = { shells: o.shells ?? [], reads: new Map(), stopped: new Set(), stops: [], backgrounds: [], background: o.background ?? true, refuseStop: o.refuseStop ?? [] };
  const startModes: Mode[] = [];
  const setModes: Mode[] = [];
  const setModels: (string | null)[] = [];
  const setEfforts: (EffortLevel | null)[] = [];
  const starts: Started[] = [];
  const cwdOf = (x: FakeSessionScript) => (x.cwd ? path.resolve(o.base ?? '/', x.cwd) : undefined);
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const sessions = o.sessions ?? [];
  const titles = (x: FakeSessionScript) => ({
    ...(x.customTitle !== undefined ? { customTitle: x.customTitle } : {}),
    ...(x.summary !== undefined ? { summary: x.summary } : {}),
    ...(x.firstPrompt !== undefined ? { firstPrompt: x.firstPrompt } : {}),
  });
  return {
    capabilities: { ...CLAUDE_CAPABILITIES, ...o.capabilities },
    startModes,
    setModes,
    setModels,
    setEfforts,
    starts,
    stops: tasks.stops,
    backgrounds: tasks.backgrounds,
    start: (s) => {
      startModes.push(s.permissionMode);
      starts.push({
        cwd: s.cwd, permissionMode: s.permissionMode, ...(s.resume ? { resume: s.resume } : {}), ...(s.fork ? { fork: true } : {}),
        ...(s.model ? { model: s.model } : {}), ...(s.effort ? { effort: s.effort } : {}),
      });
      return new FakeSession(turns, s.ask, setModes, { options: o.models ?? [], ...(s.model ? { running: s.model } : {}), sets: setModels, efforts: setEfforts }, tasks, s.resume, s.fork);
    },
    listSessions: async () => sessions.map((x) => {
      const cwd = cwdOf(x);
      return { sessionId: x.id, ...titles(x), lastModified: x.lastModified ?? 0, fileSize: x.fileSize ?? 0, ...(cwd ? { cwd } : {}) };
    }),
    // like getSessionInfo({ dir }): only a session of that project dir is found
    sessionInfo: async (id, dir) => {
      const x = sessions.find((e) => e.id === id && cwdOf(e) !== undefined && real(cwdOf(e)!) === real(dir));
      return x ? { ...titles(x), cwd: cwdOf(x)! } : null;
    },
    subagent: async (_session, _cwd, toolUseId, attachments, onError) => {
      const a = (o.subagents ?? []).find((x) => x.toolUseId === toolUseId);
      return a ? { events: transcriptToEvents(subagentMessages(a), attachments, onError, { subagent: true }), running: a.running ?? false, type: a.type ?? '', description: a.description } : null;
    },
    history: async (id) => {
      await sleepFor(o.historyDelayMs ?? 0); // e2e: a switch that visibly takes time
      return (sessions.find((e) => e.id === id)?.history ?? []).flatMap((h, i): ServerEvent[] => (h.role === 'user'
        ? [{ kind: 'user', id: `fake-h-${i}`, text: h.text, historic: true, ts: 0 }]
        : mapSdk(sdk({ type: 'assistant', uuid: `fake-h-${i}`, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: h.text }] } }))
          .filter(isWire).map((e) => ({ kind: 'agent', e, ts: 0 }))));
    },
  };
}

/** Reads a --fake script (either format). */
export function fakeFromScript(script: FakeScript, base: string): ReturnType<typeof fakeBackend> {
  return Array.isArray(script)
    ? fakeBackend(script, { base })
    : fakeBackend(script.turns, { sessions: script.sessions ?? [], base, ...(script.historyDelayMs ? { historyDelayMs: script.historyDelayMs } : {}), ...(script.capabilities ? { capabilities: script.capabilities } : {}), ...(script.models ? { models: script.models } : {}), ...(script.subagents ? { subagents: script.subagents } : {}), ...(script.shells ? { shells: script.shells } : {}), ...(script.background !== undefined ? { background: script.background } : {}), ...(script.refuseStop ? { refuseStop: script.refuseStop } : {}) });
}
