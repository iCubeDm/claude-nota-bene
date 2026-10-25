import type { ServerEvent } from '@nota-bene/shared';

export type FeedItem =
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; duringWork?: boolean }
  | { kind: 'assistant'; id: string; text: string; final: boolean } // `${uuid}:${blockIndex}`; while streaming `stream:${n}`
  | {
      kind: 'tool'; id: string; name: string; arg: string; sub: boolean;
      /** the full tool input; the one-line `arg` is only its summary */
      input: Record<string, unknown>;
      /** from the tool_result with the same tool_use_id; absent while the tool still runs */
      result?: { text: string; isError: boolean };
    }
  | { kind: 'done'; secs: number; ts: number; status: 'done' | 'interrupted' | 'failed'; error?: string }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; answer?: boolean }
  | { kind: 'notice'; text: string };

export type FeedState = {
  items: FeedItem[];
  busy: boolean;
  session: { id: string | null; root: string } | null;
  /** a forced user message was sent: the next result ends the interrupted turn but not the new one. */
  forcePending: boolean;
  /** ids of live sends no result has answered yet (results name them in user_message_uuids). */
  waiting: string[];
  /** counter behind the streaming ids `stream:${n}`; kept in state so reduce stays pure and replay is deterministic. */
  streamN: number;
};

export const emptyFeed: FeedState = { items: [], busy: false, session: null, forcePending: false, waiting: [], streamN: 0 };

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
      return { ...s, items: [...closed, done], busy, forcePending: false, waiting };
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
      return ev.events.reduce(reduce, emptyFeed);
    case 'sdk':
      return reduceSdk(s, ev.m as unknown as Sdk, ev.ts);
    case 'user': {
      const item: FeedItem = {
        kind: 'user', id: ev.id, text: ev.text, ts: ev.ts,
        ...(ev.force ? { force: true } : {}),
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
      return { ...s, session: { id: ev.id, root: ev.root } };
    case 'resumed':
      return { ...s, items: [...s.items, { kind: 'notice', text: ev.id.slice(0, 8) }] };
    case 'server-error':
    case 'comments': // handled by the comments store, not the feed
      return s;
    default: {
      const never: never = ev;
      return never;
    }
  }
}
