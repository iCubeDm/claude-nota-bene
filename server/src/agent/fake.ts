import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, AgentSession, PermissionAsk } from './types.ts';

export type FakeTurn = {
  text: string;
  chunk?: number;
  delayMs?: number;
  tools?: { name: string; input: Record<string, unknown> }[];
  ask?: { toolName: string; input: Record<string, unknown> };
  crash?: boolean;
};

/**
 * The fake fills only the fields later code reads (type, subtype, session_id, uuid,
 * parent_tool_use_id, message.content, event, duration_ms, is_error, result). The rest of the
 * real SDK shape is deliberately not invented, so the objects are cast once, here.
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
  private pending = 0; // sends not yet started
  private wake: (() => void) | null = null;
  private closed = false;
  private turnCtl: AbortController | null = null; // set only while a turn runs
  private turnNo = 0;
  private readonly turns: FakeTurn[];
  private readonly ask: PermissionAsk;
  private readonly sessionId: string;

  constructor(turns: FakeTurn[], ask: PermissionAsk, resume?: string) {
    this.turns = turns;
    this.ask = ask;
    this.sessionId = resume ?? DEFAULT_SESSION_ID; // a resumed CLI session keeps its id
    this.messages = { [Symbol.asyncIterator]: () => this.run() };
  }

  send(_m: { uuid: string; text: string; priority: 'next' | 'now' }): void {
    if (this.closed) return;
    this.pending++;
    this.wake?.();
  }

  async interrupt(): Promise<void> {
    this.turnCtl?.abort();
  }

  close(): void {
    this.closed = true;
    this.turnCtl?.abort();
    this.wake?.();
  }

  private async *run(): AsyncGenerator<SDKMessage> {
    while (true) {
      while (this.pending === 0 && !this.closed) {
        await new Promise<void>((r) => { this.wake = r; });
        this.wake = null;
      }
      if (this.closed) return;
      this.pending--;
      yield* this.turn(this.turns[Math.min(this.turnNo, this.turns.length - 1)] ?? { text: '' });
      if (this.closed) return;
    }
  }

  private async *turn(t: FakeTurn): AsyncGenerator<SDKMessage> {
    const n = ++this.turnNo;
    const started = Date.now();
    const ctl = (this.turnCtl = new AbortController());
    try {
      // like the CLI: init at the start of every turn
      yield sdk({ type: 'system', subtype: 'init', session_id: this.sessionId, uuid: `fake-init-${n}` });
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
        if (t.ask) await Promise.race([this.ask(t.ask.toolName, t.ask.input, ctl.signal), whenAborted(ctl.signal)]);
      }
      if (this.closed) return;
      const interrupted = ctl.signal.aborted;
      yield sdk({
        type: 'result',
        subtype: interrupted ? 'error_during_execution' : 'success',
        session_id: this.sessionId,
        uuid: `fake-r-${n}`,
        duration_ms: Date.now() - started,
        is_error: interrupted,
        result: interrupted ? '' : t.text,
      });
    } finally {
      this.turnCtl = null;
    }
  }
}

export function fakeBackend(turns: FakeTurn[]): AgentBackend {
  return {
    start: (o) => new FakeSession(turns, o.ask, o.resume),
    history: async () => [],
  };
}
