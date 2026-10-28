import type { AgentEvent } from '@nota-bene/shared';

export type SendState = 'queued' | 'running' | 'answered' | 'cancelled' | 'failed';
type TurnEnd = Extract<AgentEvent, { t: 'turn-end' }>;
type Entry = {
  state: SendState; /** a /compact or /clear whose first result has not come yet */ commandDue: boolean;
  /** a /compact or /clear, not the user's prompt */ command: boolean;
};

const waits = (s: SendState) => s === 'queued' || s === 'running';

/**
 * Every send of the current session (R-M7-17), each `queued → running → answered | cancelled | failed`, plus the
 * turn-level facts the results depend on (a /clear's reset, a compaction inside the turn).
 *
 * Strict where the server itself drives the step: registering a known id, running an id it never registered, or
 * running a send twice throws. Tolerant where the CLI drives it, because a real CLI does all of these (see the
 * M7-11 report, T1–T4): a turn-end, `cancelled` or failure naming an unknown id or an already settled send is
 * ignored (the first settlement stands), and running a send that was settled while it waited behind another one
 * (an error result or a reset answered all) returns false. A crash does not settle queued sends: they are still
 * waiting in the SendQueue and run on the next agent.
 */
export class TurnLedger {
  private sends = new Map<string, Entry>();
  // a /clear was sent (its reset not seen yet) / its reset was seen (its result not seen yet). The real CLI follows
  // the reset with a result; it is live only, so a reload never shows a stray "done 0s" after the clear
  private clearSent = false;
  private clearResultDue = false;
  private compactedInTurn = false;

  /** throws when the id is known; registers nothing (a refused send must have no side effects) */
  assertNew(id: string): void {
    if (this.sends.has(id)) throw new Error(`send ${id} is already known`);
  }

  /** a new send: queued; throws when the id is known */
  sent(id: string, o: { command?: 'compact' | 'clear' } = {}): void {
    this.assertNew(id);
    this.sends.set(id, { state: 'queued', commandDue: !!o.command, command: !!o.command });
    if (o.command) {
      this.clearSent = o.command === 'clear';
      this.clearResultDue = false;
    }
  }

  /**
   * queued → running (handed to the agent). Throws for an id never registered and for a running send. A send
   * already settled while it waited (an error result answered all, a reset; not a crash, M7-18) returns false and
   * stays settled (T3); the caller still hands it over, as before M7-11.
   */
  running(id: string): boolean {
    const s = this.sends.get(id);
    if (!s) throw new Error(`running: unknown send ${id}`);
    if (s.state === 'running') throw new Error(`send ${id} is already running`);
    if (s.state !== 'queued') return false;
    s.state = 'running';
    return true;
  }

  state(id: string): SendState | undefined {
    return this.sends.get(id)?.state;
  }

  /** a send or a command still waiting for its result: a compaction's cut keeps its event (R-M7-12) */
  inFlight(id: string): boolean {
    const s = this.sends.get(id);
    return !!s && waits(s.state);
  }

  /** applies a result frame: `store` false for a /clear's own result, `arm` whether idle compaction should arm */
  turnEnd(e: TurnEnd): { store: boolean; arm: boolean } {
    this.settle(e.answers, e.stop === 'failed' ? 'failed' : 'answered');
    const store = !this.clearResultDue;
    this.clearResultDue = false;
    // a command's result (a /compact that failed or was stopped, a /clear) never arms: a failed idle compaction
    // would otherwise retry every idle stretch, keeping its own cache warm forever
    const ofCommand = Array.isArray(e.answers) && e.answers.some((id) => this.commandResult(id));
    const arm = !this.compactedInTurn && !ofCommand;
    this.compactedInTurn = false;
    return { store, arm };
  }

  /** The server answers for the agent: one send it could not hand over, or (no id) every waiting send. */
  failed(id?: string): void {
    this.settle(id === undefined ? 'all' : [id], 'failed');
  }

  /** failed(id), and the failed turn-end that says so, as the mapper makes of an SDKResultError */
  failure(e: unknown, id?: string | string[]): TurnEnd {
    const message = e instanceof Error ? e.message : String(e);
    const ids = typeof id === 'string' ? [id] : id;
    if (ids) this.settle(ids, 'failed'); else this.failed();
    return { t: 'turn-end', stop: 'failed', secs: 0, ...(message ? { error: message } : {}), answers: ids ?? 'all', queued: 0 };
  }

  /**
   * The agent died: fails the sends it had (running); queued ones were never handed over and stay queued for the
   * next agent. The event names exactly those ids; `answers: []` when none ran, which answers nothing (a reducer
   * filters the waiting list by it, `turnEnd` settles nothing), the failed line still shows the error.
   */
  crashed(e: unknown): TurnEnd {
    const ids = [...this.sends].filter(([, s]) => s.state === 'running').map(([id]) => id);
    return this.failure(e, ids);
  }

  /** a queued send the CLI cancelled: it never gets a result of its own */
  cancelled(id: string): void {
    this.settle([id], 'cancelled');
  }

  /** a compaction in this turn: its result does not arm (the next turn's does) */
  compactBoundary(): void {
    this.compactedInTurn = true;
  }

  /** a conversation_reset: clears waiting; the next result is a /clear's own when a /clear was sent */
  reset(): void {
    this.settle('all', 'answered'); // the CLI's result for a /clear follows the reset; waiting must not depend on it
    this.clearResultDue = this.clearSent;
    this.clearSent = false;
  }

  /** a real user send follows: the next result is a normal one */
  userTurn(): void {
    this.clearSent = this.clearResultDue = false;
  }

  waiting(): number {
    let n = 0;
    for (const s of this.sends.values()) if (waits(s.state)) n++;
    return n;
  }

  /** a new session: every send and flag forgotten */
  clear(): void {
    this.sends.clear();
    this.clearSent = this.clearResultDue = this.compactedInTurn = false;
  }

  private settle(ids: TurnEnd['answers'], to: SendState): void {
    if (ids === 'none') return;
    const hit = ids === 'all' ? [...this.sends.values()] : ids.map((id) => this.sends.get(id));
    for (const s of hit) if (s && waits(s.state)) s.state = to;
  }

  private commandResult(id: string): boolean {
    const s = this.sends.get(id);
    if (!s?.commandDue) return false;
    s.commandDue = false;
    return true;
  }
}

export type Activity = 'idle' | 'turn' | 'asking';

/** The global activity, derived, never stored (R-M7-17): sends and asks overlap, so only their counts are the truth. */
export function activity(turns: TurnLedger, permissions: { pending(): number }): Activity {
  if (permissions.pending() > 0) return 'asking';
  return turns.waiting() > 0 ? 'turn' : 'idle';
}
