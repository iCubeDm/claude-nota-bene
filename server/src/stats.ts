import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Limit, Stats } from '@nota-bene/shared';
import type { AgentSession } from './agent/types.ts';

const CONTEXT_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = 15_000;
const FIRST_TICK_MS = 1_500;
const TICK_MS = 5 * 60_000;
const LIMITS_THROTTLE_MS = 60_000;

/** Thrown by `AgentSession.usage()` when the SDK has no usage API (it is experimental and may be removed). */
export class UsageUnavailableError extends Error {
  constructor(message = 'the SDK has no usage API') {
    super(message);
    this.name = 'UsageUnavailableError';
  }
}

type RawContext = { totalTokens: number; rawMaxTokens?: number; maxTokens: number; percentage: number };
type RawWindow = { utilization: number | null; resets_at: string | null } | null | undefined;
type RawUsage = {
  session: { total_cost_usd: number };
  rate_limits_available: boolean;
  rate_limits: { five_hour?: RawWindow; seven_day?: RawWindow } | null;
};

/** Prototype mapping: used = totalTokens, max = rawMaxTokens || maxTokens, pct = percentage. */
export function mapContextUsage(r: RawContext): NonNullable<Stats['context']> {
  return { used: r.totalTokens, max: r.rawMaxTokens || r.maxTokens, pct: r.percentage };
}

const mapWindow = (w: RawWindow): Limit | null =>
  w && w.utilization != null ? { utilization: w.utilization, resets_at: w.resets_at ?? null } : null;

export function mapUsage(r: RawUsage): { cost: number | null; limits: Stats['limits'] } {
  return {
    cost: typeof r.session?.total_cost_usd === 'number' ? r.session.total_cost_usd : null,
    limits: r.rate_limits_available && r.rate_limits
      ? { five_hour: mapWindow(r.rate_limits.five_hour), seven_day: mapWindow(r.rate_limits.seven_day) }
      : null,
  };
}

/**
 * Rejects after `ms`. The wrapped promise gets a handler on both outcomes, so a rejection that arrives after the
 * timeout is swallowed here instead of surfacing as an unhandled rejection.
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
    timer.unref();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// "At most one server-error per process": the set outlives any one service (M4-04 restarts it on a switch).
const reported = new Set<string>();
/** Tests only. */
export function resetStatsReports(): void {
  reported.clear();
}

const EMPTY: Stats = { context: null, limits: null, cost: null };

type Msg = { type?: string; subtype?: string; rate_limit_info?: { rateLimitType?: string; utilization?: number; resetsAt?: number } };

export class StatsService {
  private readonly o: { session: () => AgentSession | null; emit: (s: Stats) => void; onError?: (e: unknown) => void; now?: () => number };
  private stats: Stats = EMPTY;
  private lastEmitted = JSON.stringify(EMPTY);
  private lastLimitsAt = -Infinity;
  private limitsUnavailable = false;
  private running: Promise<void> | null = null;
  private rerun: { limits: boolean } | null = null;
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private generation = 0;

  constructor(o: { session: () => AgentSession | null; emit: (s: Stats) => void; onError?: (e: unknown) => void; now?: () => number }) {
    this.o = o;
  }

  current(): Stats {
    return this.stats;
  }

  /** Context always; limits at most once a minute unless `limits: true` forces them. Never rejects. */
  refresh(o: { limits?: boolean } = {}): Promise<void> {
    if (this.running) {
      // one pass at a time: the newer request runs right after, so it sees state that is newer than the current call
      this.rerun = { limits: (this.rerun?.limits ?? false) || o.limits === true };
      return this.running;
    }
    const run = (async () => {
      let next: { limits: boolean } | undefined = { limits: o.limits === true };
      while (next) {
        this.rerun = null;
        await this.pass(next.limits);
        next = this.rerun ?? undefined;
      }
    })().finally(() => { this.running = null; });
    this.running = run;
    return run;
  }

  /** Cheap: called for every sdk message, so it looks at `type` first and does nothing for the common ones. */
  onSdk(m: SDKMessage): void {
    const { type, subtype, rate_limit_info: info } = m as Msg;
    if (type === 'result') {
      void this.refresh();
    } else if (type === 'system') {
      if (subtype === 'conversation_reset' || subtype === 'compact_boundary') void this.refresh();
    } else if (type === 'rate_limit_event' && info) {
      this.mergeRateLimit(info);
    }
  }

  start(): void {
    if (this.first || this.every) return;
    const tick = () => void this.refresh({ limits: true }); // the 5-minute tick also resets the throttle
    this.first = setTimeout(tick, FIRST_TICK_MS);
    this.every = setInterval(tick, TICK_MS);
    this.first.unref();
    this.every.unref();
  }

  stop(): void {
    this.generation++; // an in-flight refresh must not publish after this
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    this.first = this.every = null;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private async pass(forceLimits: boolean): Promise<void> {
    const gen = this.generation;
    const session = this.o.session();
    if (!session) return;
    const wantLimits = !this.limitsUnavailable && (forceLimits || this.now() - this.lastLimitsAt >= LIMITS_THROTTLE_MS);
    if (wantLimits) this.lastLimitsAt = this.now(); // a failure also waits out the throttle
    const [ctx, usage] = await Promise.all([
      withTimeout(session.contextUsage(), CONTEXT_TIMEOUT_MS, 'context usage').then((v) => ({ v }), (e: unknown) => ({ e })),
      wantLimits
        ? withTimeout(session.usage(), USAGE_TIMEOUT_MS, 'usage').then((v) => ({ v }), (e: unknown) => ({ e }))
        : Promise.resolve(null),
    ]);
    if (gen !== this.generation || session !== this.o.session()) return; // stopped or switched while waiting
    const next = { ...this.stats };
    if ('v' in ctx) next.context = ctx.v;
    else this.fail('context', ctx.e);
    if (usage) {
      if ('v' in usage) {
        next.cost = usage.v.cost;
        next.limits = usage.v.limits;
      } else {
        if (usage.e instanceof UsageUnavailableError) this.limitsUnavailable = true;
        this.fail('usage', usage.e);
      }
    }
    this.publish(next);
  }

  private mergeRateLimit(info: NonNullable<Msg['rate_limit_info']>): void {
    const { rateLimitType: kind, utilization: u, resetsAt } = info;
    if ((kind !== 'five_hour' && kind !== 'seven_day') || u == null) return;
    const limit: Limit = { utilization: u <= 1 ? u * 100 : u, resets_at: resetsAt ? new Date(resetsAt * 1000).toISOString() : null };
    const prev = this.stats.limits ?? { five_hour: null, seven_day: null };
    this.publish({ ...this.stats, limits: { ...prev, [kind]: limit } });
  }

  private publish(next: Stats): void {
    this.stats = next;
    const json = JSON.stringify(next);
    if (json === this.lastEmitted) return; // the 5-minute tick must not spam sockets
    this.lastEmitted = json;
    this.o.emit(next);
  }

  private fail(api: string, e: unknown): void {
    if (reported.has(api)) return;
    reported.add(api);
    this.o.onError?.(e);
  }
}
