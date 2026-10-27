import type { ImageRef, ServerEvent, WireAgentEvent } from '@nota-bene/shared';

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
  /** ids of live sends no turn-end has answered yet (a turn-end names them in `answers`). */
  waiting: string[];
  /** counter behind the streaming ids `stream:${n}`; kept in state so reduce stays pure and replay is deterministic. */
  streamN: number;
  /** live turn-ends seen so far; a replay does not count. Consumers (the file tree) refresh when it changes. */
  turnSeq: number;
  /** ts of the `compacting` event while a compaction (manual or auto) runs; null otherwise */
  compacting: number | null;
};

export const emptyFeed: FeedState = { items: [], busy: false, session: null, forcePending: false, waiting: [], streamN: 0, turnSeq: 0, compacting: null };

export const ARG_KEYS = ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'skill', 'prompt'];

function toolArg(input: Record<string, unknown> | undefined): string {
  for (const k of ARG_KEYS) {
    const v = input?.[k];
    if (v) return String(v).split('\n')[0]!.slice(0, 160);
  }
  return '';
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

function reduceAgent(s: FeedState, e: WireAgentEvent, ts: number): FeedState {
  switch (e.t) {
    case 'reset': // live only (never stored): the server's replay [] came first, this adds the line
      return { ...emptyFeed, session: s.session, turnSeq: s.turnSeq, items: [{ kind: 'marker', what: 'cleared', ts }] };
    // a compaction: compacting, then its end (compact-failed, compact-end), then (on success) compacted
    case 'compacting':
      return { ...s, compacting: ts };
    case 'compact-end':
      return s.compacting === null ? s : { ...s, compacting: null };
    case 'compact-failed': {
      if (s.compacting === null) return s;
      const failed: FeedItem = { kind: 'marker', what: 'compactFailed', ts, ...(e.error ? { error: e.error } : {}) };
      return { ...s, compacting: null, items: [...s.items, failed] };
    }
    case 'compacted':
      return {
        ...s,
        compacting: null,
        items: [...s.items, { kind: 'marker', what: 'compacted', pre: e.preTokens, ts, ...(e.ms ? { ms: e.ms } : {}) }],
      };
    case 'message-start': {
      const item: FeedItem = { kind: 'assistant', id: `stream:${s.streamN}`, text: '', final: false };
      return { ...s, items: [...s.items, item], streamN: s.streamN + 1 };
    }
    case 'message-chunk': {
      const i = lastOpenIndex(s.items);
      const cur = s.items[i];
      if (!cur || cur.kind !== 'assistant') return s;
      return { ...s, items: replaceAt(s.items, i, { ...cur, text: cur.text + e.text }) };
    }
    case 'message': {
      const final: FeedItem = { kind: 'assistant', id: e.id, text: e.text, final: true };
      const i = firstOpenIndex(s.items); // k-th text block takes the k-th open stream
      return { ...s, items: i >= 0 ? replaceAt(s.items, i, final) : [...s.items, final] };
    }
    case 'tool-call':
      return { ...s, items: [...s.items, { kind: 'tool', id: e.id, name: e.name, arg: toolArg(e.input), sub: e.sub, input: e.input }] };
    case 'tool-update': {
      // A result whose tool item is not in the feed (should not happen) is ignored.
      const i = s.items.findIndex((it) => it.kind === 'tool' && it.id === e.id);
      const cur = s.items[i];
      if (!cur || cur.kind !== 'tool') return s;
      return { ...s, items: replaceAt(s.items, i, { ...cur, result: { text: e.text, isError: e.isError } }) };
    }
    case 'turn-end': {
      // a forced send interrupts the running turn: whatever ends it shows as interrupted (R-M7-14)
      const status = s.forcePending ? 'interrupted' : e.stop;
      const done: FeedItem = {
        kind: 'done', secs: e.secs, ts, status,
        ...(status === 'failed' && e.error ? { error: e.error } : {}),
      };
      // a stream still open at the turn's end was cut short: keep its partial text as final, drop it if empty
      const closed = s.items.flatMap((it): FeedItem[] =>
        it.kind === 'assistant' && !it.final ? (it.text ? [{ ...it, final: true }] : []) : [it]);
      // A message sent mid-turn runs next as its own turn. The CLI was seen reporting no queued turns with a send
      // already queued, so busy also follows the sends no turn-end has named yet. `all`: an error result naming no
      // send answers every waiting one; `none`: a synthetic turn (task notification, cron) answers none of them.
      const waiting = e.answers === 'all' ? [] : e.answers === 'none' ? s.waiting
        : s.waiting.filter((id) => !(e.answers as string[]).includes(id));
      const busy = s.forcePending || e.queued > 0 || waiting.length > 0;
      // the live result that follows a clear still arrives: with no user message since the cleared line there is no turn to report
      const lastCleared = closed.findLastIndex((it) => it.kind === 'marker' && it.what === 'cleared');
      const orphan = lastCleared >= 0 && !closed.slice(lastCleared).some((it) => it.kind === 'user');
      // a turn never ends mid-compaction: a turn-end with one still shown means its end event was lost (the agent died)
      return { ...s, items: orphan ? closed : [...closed, done], busy, forcePending: false, waiting, turnSeq: s.turnSeq + 1, compacting: null };
    }
    case 'cancelled': {
      // a queued send that was cancelled (e.g. Stop with cancel_queued) never gets a turn-end of its own
      if (!s.waiting.includes(e.sendId)) return s;
      const waiting = s.waiting.filter((id) => id !== e.sendId);
      return { ...s, waiting, busy: s.forcePending || waiting.length > 0 };
    }
    case 'mode': // the controls slice reads the `mode` server event
    case 'task': // the tasks slice
    case 'suggestion': // the controls slice
      return s;
    default: {
      const never: never = e;
      return never;
    }
  }
}

export function reduce(s: FeedState, ev: ServerEvent): FeedState {
  switch (ev.kind) {
    case 'replay':
      // the replayed results are history: keep the live counter, or a reconnect would look like a finished turn
      return { ...ev.events.reduce(reduce, emptyFeed), turnSeq: s.turnSeq };
    case 'agent':
      return reduceAgent(s, ev.e, ev.ts);
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
