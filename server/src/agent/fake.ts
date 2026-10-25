import fs from 'node:fs';
import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Mode, ServerEvent, Stats } from '@nota-bene/shared';
import type { AgentBackend, AgentSession, PermissionAsk } from './types.ts';

export type FakeTurn = {
  text: string;
  chunk?: number;
  delayMs?: number;
  /** `output` becomes the tool_result the CLI would stream back (default empty) */
  tools?: { name: string; input: Record<string, unknown>; output?: string; isError?: boolean }[];
  ask?: { toolName: string; input: Record<string, unknown> };
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
export type FakeScript = FakeTurn[] | { turns: FakeTurn[]; sessions?: FakeSessionScript[] };

/**
 * The fake fills only the fields later code reads (type, subtype, session_id, uuid,
 * parent_tool_use_id, message.content, event, duration_ms, is_error, result, terminal_reason,
 * queued_turn_count, user_message_uuid(s)), with the values the real CLI uses (server/test/fixtures/real-frames.json).
 * The rest of the real SDK shape is deliberately not invented, so the objects are cast once, here.
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

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

class FakeSession implements AgentSession {
  readonly messages: AsyncIterable<SDKMessage>;
  private pending: { uuid: string; images: number }[] = []; // sends not yet started
  private wake: (() => void) | null = null;
  private closed = false;
  private turnCtl: AbortController | null = null; // set only while a turn runs
  private turnNo = 0;
  private readonly turns: FakeTurn[];
  private readonly ask: PermissionAsk;
  private readonly modes: Mode[];
  private readonly sessionId: string;

  constructor(turns: FakeTurn[], ask: PermissionAsk, modes: Mode[], resume?: string) {
    this.turns = turns;
    this.modes = modes;
    this.ask = ask;
    this.sessionId = resume ?? DEFAULT_SESSION_ID; // a resumed CLI session keeps its id
    this.messages = { [Symbol.asyncIterator]: () => this.run() };
  }

  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: unknown[] }): void {
    if (this.closed) return;
    this.pending.push({ uuid: m.uuid, images: m.images?.length ?? 0 });
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
    return this.turns[Math.min(Math.max(this.turnNo - 1, 0), this.turns.length - 1)];
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
      const { uuid, images } = this.pending.shift()!;
      const base = this.turns[Math.min(this.turnNo, this.turns.length - 1)] ?? { text: '' };
      yield* this.turn(base.echoImages ? { ...base, text: `${base.text}${base.text ? '\n' : ''}images: ${images}` } : base, uuid);
      if (this.closed) return;
    }
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
          await Promise.race([this.ask(t.ask.toolName, t.ask.input, ctl.signal), whenAborted(ctl.signal)]);
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
    } finally {
      this.turnCtl = null;
    }
  }
}

type Started = { cwd: string; permissionMode: Mode; resume?: string };

/**
 * `startModes` records the mode each agent started with, `setModes` every setPermissionMode call, `starts` every
 * start's cwd, mode and resume id. `sessions` scripts listSessions / sessionInfo / history; `base` resolves their
 * relative cwds.
 */
export function fakeBackend(
  turns: FakeTurn[],
  o: { sessions?: FakeSessionScript[]; base?: string } = {},
): AgentBackend & { startModes: Mode[]; setModes: Mode[]; starts: Started[] } {
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
      starts.push({ cwd: s.cwd, permissionMode: s.permissionMode, ...(s.resume ? { resume: s.resume } : {}) });
      return new FakeSession(turns, s.ask, setModes, s.resume);
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
    history: async (id) => (sessions.find((e) => e.id === id)?.history ?? []).map((h, i): ServerEvent => (h.role === 'user'
      ? { kind: 'user', id: `fake-h-${i}`, text: h.text, historic: true, ts: 0 }
      : { kind: 'sdk', m: sdk({ type: 'assistant', uuid: `fake-h-${i}`, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: h.text }] } }), ts: 0 })),
  };
}

/** Reads a --fake script (either format). */
export function fakeFromScript(script: FakeScript, base: string): ReturnType<typeof fakeBackend> {
  return Array.isArray(script) ? fakeBackend(script, { base }) : fakeBackend(script.turns, { sessions: script.sessions ?? [], base });
}
