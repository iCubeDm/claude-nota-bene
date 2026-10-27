import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, Mode, ServerEvent, Stats } from '@nota-bene/shared';
import { mapFrames, mapSdk, type SDKMessage } from './claude/map.ts';
import type { AgentBackend, AgentSession, PermissionAsk } from './types.ts';

export type FakeTurn = {
  text: string;
  chunk?: number;
  delayMs?: number;
  /** `output` becomes the tool_result the CLI would stream back (default empty) */
  tools?: { name: string; input: Record<string, unknown>; output?: string; isError?: boolean }[];
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

/** A --fake script: the turns alone (the M0-M3 format), or the turns and a session list. */
export type FakeScript = FakeTurn[] | { turns: FakeTurn[]; sessions?: FakeSessionScript[]; historyDelayMs?: number };

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
  private sessionId: string; // a /clear replaces it

  constructor(turns: FakeTurn[], ask: PermissionAsk, modes: Mode[], resume?: string, fork?: boolean) {
    this.turns = turns;
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

  async setPermissionMode(mode: Mode): Promise<void> {
    this.modes.push(mode);
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
        ...(t.initMode ? { permissionMode: t.initMode } : {}), ...(t.model ? { model: t.model } : {}),
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
              ...(t.tools ?? []).map((tool, k) => ({ type: 'tool_use', id: `fake-tool-${n}-${k}`, name: tool.name, input: tool.input })),
            ],
          },
        });
        if (t.tools?.length) {
          yield sdk({
            type: 'user', session_id: this.sessionId, uuid: `fake-u-${n}`, parent_tool_use_id: null,
            message: {
              role: 'user',
              content: t.tools.map((tool, k) => ({
                type: 'tool_result', tool_use_id: `fake-tool-${n}-${k}`, content: tool.output ?? '',
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

type Started = { cwd: string; permissionMode: Mode; resume?: string; fork?: boolean };

/**
 * `startModes` records the mode each agent started with, `setModes` every setPermissionMode call, `starts` every
 * start's cwd, mode and resume id. `sessions` scripts listSessions / sessionInfo / history; `base` resolves their
 * relative cwds.
 */
export function fakeBackend(
  turns: FakeTurn[],
  o: { sessions?: FakeSessionScript[]; base?: string; historyDelayMs?: number } = {},
): Omit<AgentBackend, 'start'> & { start: (o: Parameters<AgentBackend['start']>[0]) => FakeAgentSession; startModes: Mode[]; setModes: Mode[]; starts: Started[] } {
  const startModes: Mode[] = [];
  const setModes: Mode[] = [];
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
    startModes,
    setModes,
    starts,
    start: (s) => {
      startModes.push(s.permissionMode);
      starts.push({ cwd: s.cwd, permissionMode: s.permissionMode, ...(s.resume ? { resume: s.resume } : {}), ...(s.fork ? { fork: true } : {}) });
      return new FakeSession(turns, s.ask, setModes, s.resume, s.fork);
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
    history: async (id) => {
      await sleepFor(o.historyDelayMs ?? 0); // e2e: a switch that visibly takes time
      return (sessions.find((e) => e.id === id)?.history ?? []).flatMap((h, i): ServerEvent[] => (h.role === 'user'
        ? [{ kind: 'user', id: `fake-h-${i}`, text: h.text, historic: true, ts: 0 }]
        : mapSdk(sdk({ type: 'assistant', uuid: `fake-h-${i}`, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: h.text }] } }))
          .map((e) => ({ kind: 'agent', e, ts: 0 }))));
    },
  };
}

/** Reads a --fake script (either format). */
export function fakeFromScript(script: FakeScript, base: string): ReturnType<typeof fakeBackend> {
  return Array.isArray(script)
    ? fakeBackend(script, { base })
    : fakeBackend(script.turns, { sessions: script.sessions ?? [], base, ...(script.historyDelayMs ? { historyDelayMs: script.historyDelayMs } : {}) });
}
