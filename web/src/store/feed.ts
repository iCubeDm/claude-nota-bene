import type { ImageRef, ServerEvent } from '@nota-bene/shared';

export type FeedItem =
  /** idle: the server's own /compact after a quiet stretch, shown as a line, not as the user's message */
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; duringWork?: boolean; images?: ImageRef[]; idle?: boolean }
  | { kind: 'assistant'; id: string; text: string; final: boolean } // `${uuid}:${blockIndex}`; while streaming `stream:${n}`
  | {
      kind: 'tool'; id: string; name: string; arg: string; sub: boolean;
      /** the full tool input; the one-line `arg` is only its summary */
      input: Record<string, unknown>;
      /** from the tool_result with the same tool_use_id; absent while the tool still runs */
      result?: { text: string; isError: boolean };
    }
  /**
   * a one-line mark in the transcript: the context was compacted (pre = tokens before, ms = how long it took), a
   * compaction failed (error = the CLI's text), or the context was cleared; ts 0 = no time
   */
  | { kind: 'marker'; what: 'compacted' | 'compactFailed' | 'cleared'; pre?: number; ms?: number; error?: string; ts: number }
  | { kind: 'done'; secs: number; ts: number; status: 'done' | 'interrupted' | 'failed'; error?: string }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; answer?: boolean }
  /** `text`: the resumed session id; translated at render. (Server errors are toasts, not feed items: R-M4-5.) */
  | { kind: 'notice'; text: string };

export type FeedState = {
  items: FeedItem[];
  busy: boolean;
  session: { id: string | null; root: string; title: string | null; model: string | null } | null;
  /** a forced user message was sent: the next result ends the interrupted turn but not the new one. */
  forcePending: boolean;
  /** ids of live sends no result has answered yet (results name them in user_message_uuids). */
  waiting: string[];
  /** counter behind the streaming ids `stream:${n}`; kept in state so reduce stays pure and replay is deterministic. */
  streamN: number;
  /** live results seen so far; a replay does not count. Consumers (the file tree) refresh when it changes. */
  turnSeq: number;
  /** ts of the `status: compacting` frame while a compaction (manual or auto) runs; null otherwise */
  compacting: number | null;
};

export const emptyFeed: FeedState = { items: [], busy: false, session: null, forcePending: false, waiting: [], streamN: 0, turnSeq: 0, compacting: null };

// Loose view of the SDK message: only the fields the feed reads (real shapes: server/test/fixtures/real-frames.json).
type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown };
type Sdk = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } };
  message?: { content?: unknown };
  duration_ms?: number;
  is_error?: boolean;
  result?: unknown;
  errors?: unknown;
  terminal_reason?: string;
  queued_turn_count?: number;
  user_message_uuid?: string;
  user_message_uuids?: string[];
  command_uuid?: string;
  state?: string;
  compact_metadata?: { pre_tokens?: number; duration_ms?: number };
  status?: string | null;
  compact_result?: string;
  compact_error?: string;
};

export const ARG_KEYS = ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'skill', 'prompt'];

function toolArg(input: Record<string, unknown> | undefined): string {
  for (const k of ARG_KEYS) {
    const v = input?.[k];
    if (v) return String(v).split('\n')[0]!.slice(0, 160);
  }
  return '';
}

/** tool_result content: a string, or blocks (text joined, images shown as [image]). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Block[]) {
    if (b?.type === 'text') parts.push(b.text ?? '');
    else if (b?.type === 'image') parts.push('[image]');
    else if (b?.type) parts.push(`[${b.type}]`);
  }
  return parts.join('\n');
}

function firstOpenIndex(items: FeedItem[]): number {
  return items.findIndex((it) => it.kind === 'assistant' && !it.final);
}

function lastOpenIndex(items: FeedItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'assistant' && !it.final) return i;
  }
  return -1;
}

function replaceAt(items: FeedItem[], i: number, it: FeedItem): FeedItem[] {
  const next = items.slice();
  next[i] = it;
  return next;
}

function blocks(m: Sdk): Block[] {
  const c = m.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

function reduceSdk(s: FeedState, m: Sdk, ts: number): FeedState {
  const sub = !!m.parent_tool_use_id;
  switch (m.type) {
    case 'conversation_reset': // live only (never stored): the server's replay [] came first, this adds the line
      return { ...emptyFeed, session: s.session, turnSeq: s.turnSeq, items: [{ kind: 'marker', what: 'cleared', ts }] };
    case 'system':
      // a compaction: status compacting, then status null with its compact_result, then (on success) the boundary
      if (m.subtype === 'status') {
        // the CLI repeats it as a keepalive (every 30 s) and at each phase: the compaction started at the first one
        if (m.status === 'compacting') return s.compacting === null ? { ...s, compacting: ts } : s;
        if (m.status !== null || s.compacting === null) return s;
        if (m.compact_result !== 'failed') return { ...s, compacting: null };
        const failed: FeedItem = { kind: 'marker', what: 'compactFailed', ts, ...(m.compact_error ? { error: m.compact_error } : {}) };
        return { ...s, compacting: null, items: [...s.items, failed] };
      }
      if (m.subtype !== 'compact_boundary') return s;
      return {
        ...s,
        compacting: null,
        items: [...s.items, {
          kind: 'marker', what: 'compacted', pre: m.compact_metadata?.pre_tokens ?? 0, ts,
          ...(m.compact_metadata?.duration_ms ? { ms: m.compact_metadata.duration_ms } : {}),
        }],
      };
    case 'stream_event': {
      if (sub) return s;
      const ev = m.event;
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
        const item: FeedItem = { kind: 'assistant', id: `stream:${s.streamN}`, text: '', final: false };
        return { ...s, items: [...s.items, item], streamN: s.streamN + 1 };
      }
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const i = lastOpenIndex(s.items);
        const cur = s.items[i];
        if (!cur || cur.kind !== 'assistant') return s;
        return { ...s, items: replaceAt(s.items, i, { ...cur, text: cur.text + (ev.delta.text ?? '') }) };
      }
      return s;
    }
    case 'assistant': {
      let items = s.items;
      blocks(m).forEach((b, idx) => {
        if (b.type === 'text' && !sub) {
          const final: FeedItem = { kind: 'assistant', id: `${m.uuid}:${idx}`, text: b.text ?? '', final: true };
          const i = firstOpenIndex(items); // k-th text block takes the k-th open stream
          items = i >= 0 ? replaceAt(items, i, final) : [...items, final];
        } else if (b.type === 'tool_use') {
          items = [...items, { kind: 'tool', id: b.id ?? '', name: b.name ?? '', arg: toolArg(b.input), sub, input: b.input ?? {} }];
        }
      });
      return items === s.items ? s : { ...s, items };
    }
    case 'user': {
      // Never a bubble (user text arrives as `user` events); tool_result blocks attach to their tool item by id.
      // A result whose tool item is not in the feed (should not happen) is ignored.
      let items = s.items;
      for (const b of blocks(m)) {
        if (b.type !== 'tool_result') continue;
        const i = items.findIndex((it) => it.kind === 'tool' && it.id === b.tool_use_id);
        const cur = items[i];
        if (!cur || cur.kind !== 'tool') continue;
        const isError = !!b.is_error;
        items = replaceAt(items, i, { ...cur, result: { text: resultText(b.content), isError } });
      }
      return items === s.items ? s : { ...s, items };
    }
    case 'result': {
      // the CLI ends an interrupted turn with subtype success and terminal_reason aborted_streaming | aborted_tools
      const interrupted = s.forcePending || !!m.terminal_reason?.startsWith('aborted')
        || (m.subtype === 'error_during_execution' && !m.is_error);
      const failed = !interrupted && (!!m.is_error || (m.subtype !== undefined && m.subtype !== 'success'));
      // success + is_error carries the text in result; SDKResultError (and the server's crash result) in errors[]
      const text = (typeof m.result === 'string' && m.result)
        || (Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === 'string').join('\n') : '');
      const done: FeedItem = {
        kind: 'done',
        secs: Math.round((m.duration_ms ?? 0) / 1000),
        ts,
        status: interrupted ? 'interrupted' : failed ? 'failed' : 'done',
        ...(failed && text ? { error: text } : {}),
      };
      // a stream still open at result was cut short: keep its partial text as final, drop it if empty
      const closed = s.items.flatMap((it): FeedItem[] =>
        it.kind === 'assistant' && !it.final ? (it.text ? [{ ...it, final: true }] : []) : [it]);
      // A message sent mid-turn runs next as its own turn. The CLI was seen reporting queued_turn_count 0 with a
      // send already queued, so busy also follows the sends no result has named yet (user_message_uuids echoes
      // the client ids, or user_message_uuid). A result naming neither is either an error (our crash / send-failure
      // result, the CLI's zeroed delivery-failure result: it answers every waiting send) or a success from a
      // synthetic turn (task notification, cron) or an older producer: that answers none of the user's sends.
      const answered = Array.isArray(m.user_message_uuids) ? m.user_message_uuids
        : typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : null;
      const waiting = answered ? s.waiting.filter((id) => !answered.includes(id))
        : m.is_error === true ? [] : s.waiting;
      const busy = s.forcePending || (m.queued_turn_count ?? 0) > 0 || waiting.length > 0;
      // the live result that follows a clear still arrives: with no user message since the cleared line there is no turn to report
      const lastCleared = closed.findLastIndex((it) => it.kind === 'marker' && it.what === 'cleared');
      const orphan = lastCleared >= 0 && !closed.slice(lastCleared).some((it) => it.kind === 'user');
      // a turn never ends mid-compaction: a result with one still shown means its end frame was lost (the agent died)
      return { ...s, items: orphan ? closed : [...closed, done], busy, forcePending: false, waiting, turnSeq: s.turnSeq + 1, compacting: null };
    }
    case 'command_lifecycle': {
      // a queued send that was cancelled (e.g. Stop with cancel_queued) never gets a result of its own
      if (m.state !== 'cancelled' || !m.command_uuid || !s.waiting.includes(m.command_uuid)) return s;
      const waiting = s.waiting.filter((id) => id !== m.command_uuid);
      return { ...s, waiting, busy: s.forcePending || waiting.length > 0 };
    }
    default:
      return s;
  }
}

export function reduce(s: FeedState, ev: ServerEvent): FeedState {
  switch (ev.kind) {
    case 'replay':
      // the replayed results are history: keep the live counter, or a reconnect would look like a finished turn
      return { ...ev.events.reduce(reduce, emptyFeed), turnSeq: s.turnSeq };
    case 'sdk':
      return reduceSdk(s, ev.m as unknown as Sdk, ev.ts);
    case 'user': {
      const item: FeedItem = {
        kind: 'user', id: ev.id, text: ev.text, ts: ev.ts,
        ...(ev.force ? { force: true } : {}),
        ...(ev.images?.length ? { images: ev.images } : {}),
        ...(ev.idle ? { idle: true } : {}),
        ...(!ev.historic && s.busy ? { duringWork: true } : {}),
      };
      return {
        ...s,
        items: [...s.items, item],
        busy: ev.historic ? s.busy : true,
        forcePending: ev.force ? true : s.forcePending,
        waiting: ev.historic ? s.waiting : [...s.waiting, ev.id],
      };
    }
    case 'permission':
      return { ...s, items: [...s.items, { kind: 'permission', id: ev.id, toolName: ev.toolName, input: ev.input }] };
    case 'permission-done': {
      const i = s.items.findIndex((it) => it.kind === 'permission' && it.id === ev.id);
      const cur = s.items[i];
      if (!cur || cur.kind !== 'permission') return s;
      return { ...s, items: replaceAt(s.items, i, { ...cur, answer: ev.allow }) };
    }
    case 'session': // sent again whenever the id changes; never a notice (the CLI inits every turn)
      return { ...s, session: { id: ev.id, root: ev.root, title: ev.title, model: ev.model } };
    case 'resumed':
      return { ...s, items: [...s.items, { kind: 'notice', text: ev.id.slice(0, 8) }] };
    case 'comments': // handled by the comments store, not the feed
    case 'stats': // handled by the stats store (M4)
    case 'mode':
    case 'idle-compact': // the controls slice
    case 'hello':
    case 'send-refused': // composer/refused.ts: restores the draft, never the feed
    case 'server-error': // a toast (store.ts), live only, never swallowed (M0 error policy)
      return s;
    default: {
      const never: never = ev;
      return never;
    }
  }
}
