import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ServerEvent, Stats } from '@nota-bene/shared';
import type { AgentSession } from './agent/types.ts';
import { EventHub } from './hub.ts';
import { StatsService, UsageUnavailableError, mapContextUsage, mapUsage, resetStatsReports } from './stats.ts';

type Usage = Awaited<ReturnType<AgentSession['usage']>>;
const LIMITS: Usage = { cost: 1.5, limits: { five_hour: { utilization: 10, resets_at: '2026-01-01T00:00:00.000Z' }, seven_day: null } };

function stub(o: { context?: () => Promise<{ used: number; max: number; pct: number }>; usage?: () => Promise<Usage> } = {}) {
  const contextUsage = vi.fn(o.context ?? (async () => ({ used: 1000, max: 200000, pct: 0.5 })));
  const usage = vi.fn(o.usage ?? (async () => LIMITS));
  return { session: { contextUsage, usage } as unknown as AgentSession, contextUsage, usage };
}

function make(s: AgentSession | null) {
  const emitted: Stats[] = [];
  const errors: unknown[] = [];
  const svc = new StatsService({ session: () => s, emit: (x) => emitted.push(x), onError: (e) => errors.push(e) });
  return { svc, emitted, errors };
}

const rate = (info: Record<string, unknown>): AgentEvent => ({ t: 'rate-limit', info });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); resetStatsReports(); });
afterEach(() => vi.useRealTimers());

describe('stats mapping', () => {
  it('maps the context from totalTokens, rawMaxTokens || maxTokens and percentage', () => {
    expect(mapContextUsage({ totalTokens: 5, rawMaxTokens: 1000, maxTokens: 800, percentage: 0.5 })).toEqual({ used: 5, max: 1000, pct: 0.5 });
    expect(mapContextUsage({ totalTokens: 5, rawMaxTokens: 0, maxTokens: 800, percentage: 0.6 })).toEqual({ used: 5, max: 800, pct: 0.6 });
  });
  it('maps usage to cost and limits, and to null limits when the plan has none', () => {
    const w = { utilization: 42, resets_at: 'x' };
    expect(mapUsage({ session: { total_cost_usd: 2 }, rate_limits_available: true, rate_limits: { five_hour: w, seven_day: { utilization: null, resets_at: null } } }))
      .toEqual({ cost: 2, limits: { five_hour: w, seven_day: null } });
    expect(mapUsage({ session: { total_cost_usd: 2 }, rate_limits_available: false, rate_limits: null })).toEqual({ cost: 2, limits: null });
  });
});

describe('StatsService', () => {
  it('refreshes the context and the limits and emits once', async () => {
    const { session, contextUsage } = stub();
    const { svc, emitted } = make(session);
    await svc.refresh();
    expect(contextUsage).toHaveBeenCalledTimes(1);
    expect(svc.current()).toEqual({ context: { used: 1000, max: 200000, pct: 0.5 }, limits: LIMITS.limits, cost: 1.5 });
    expect(emitted).toHaveLength(1);
  });

  it('throttles limits to once a minute unless forced', async () => {
    const { session, contextUsage, usage } = stub();
    const { svc } = make(session);
    await svc.refresh();
    await svc.refresh();
    expect(contextUsage).toHaveBeenCalledTimes(2);
    expect(usage).toHaveBeenCalledTimes(1);
    await svc.refresh({ limits: true });
    expect(usage).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    await svc.refresh();
    expect(usage).toHaveBeenCalledTimes(3);
  });

  it('does not emit when nothing changed', async () => {
    const { session } = stub();
    const { svc, emitted } = make(session);
    await svc.refresh();
    await svc.refresh({ limits: true });
    expect(emitted).toHaveLength(1);
  });

  it('merges a rate-limit event: utilization 0.42 gives 42, a percent stays, other types are ignored', () => {
    const { svc, emitted } = make(stub().session);
    svc.onAgent(rate({ rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1_800_000_000 }));
    expect(svc.current().limits).toEqual({ five_hour: { utilization: 42, resets_at: new Date(1_800_000_000_000).toISOString() }, seven_day: null });
    svc.onAgent(rate({ rateLimitType: 'seven_day', utilization: 61 }));
    expect(svc.current().limits?.seven_day).toEqual({ utilization: 61, resets_at: null });
    svc.onAgent(rate({ rateLimitType: 'seven_day_opus', utilization: 5 }));
    svc.onAgent(rate({ rateLimitType: 'five_hour' }));
    expect(emitted).toHaveLength(2);
  });

  it('refreshes after turn-end, reset and compacted, and ignores other events', async () => {
    const { session, contextUsage } = stub();
    const { svc } = make(session);
    for (const e of [{ t: 'message-chunk', text: 'x' }, { t: 'init' }, { t: 'compacting' }, { t: 'compact-end' }] as AgentEvent[]) svc.onAgent(e);
    await svc.refresh(); // settle
    expect(contextUsage).toHaveBeenCalledTimes(1);
    const refreshing: AgentEvent[] = [
      { t: 'turn-end', stop: 'done', secs: 0, answers: 'none', queued: 0 }, { t: 'reset' }, { t: 'compacted', preTokens: 1 },
    ];
    for (const e of refreshing) {
      svc.onAgent(e);
      await svc.refresh();
    }
    expect(contextUsage).toHaveBeenCalledTimes(1 + 2 * refreshing.length); // each event's own pass, then the explicit one
  });

  it('a throwing usage API keeps the context and reports once', async () => {
    const { session, usage } = stub({ usage: async () => { throw new Error('boom'); } });
    const { svc, errors } = make(session);
    await svc.refresh();
    await svc.refresh({ limits: true });
    expect(svc.current().context).toEqual({ used: 1000, max: 200000, pct: 0.5 });
    expect(usage).toHaveBeenCalledTimes(2); // an ordinary failure is retried
    expect(errors).toHaveLength(1);
  });

  it('a missing usage API reports once and stops asking for limits', async () => {
    const { session, usage } = stub({ usage: async () => { throw new UsageUnavailableError(); } });
    const { svc, errors } = make(session);
    await svc.refresh();
    await svc.refresh({ limits: true });
    await svc.refresh({ limits: true });
    expect(usage).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(svc.current().context).not.toBeNull();
  });

  it('a failing context call keeps the previous value', async () => {
    let fail = false;
    const { session } = stub({ context: async () => { if (fail) throw new Error('x'); return { used: 1, max: 2, pct: 50 }; } });
    const { svc, errors } = make(session);
    await svc.refresh();
    fail = true;
    await svc.refresh();
    expect(svc.current().context).toEqual({ used: 1, max: 2, pct: 50 });
    expect(errors).toHaveLength(1);
  });

  it('times out a hung call (10 s context, 15 s usage) and swallows its late rejection', async () => {
    let rejectLate: (e: Error) => void = () => {};
    const hung = new Promise<never>((_, rej) => { rejectLate = rej; });
    const { session } = stub({ context: () => hung, usage: () => new Promise(() => {}) });
    const { svc, errors } = make(session);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const p = svc.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(errors).toHaveLength(2);
    rejectLate(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(svc.current().context).toBeNull();
  });

  it('start is idempotent: first tick at 1.5 s, then every 5 minutes; stop clears the timers', async () => {
    const { session, contextUsage } = stub();
    const { svc } = make(session);
    svc.start();
    svc.start();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(contextUsage).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(contextUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(contextUsage).toHaveBeenCalledTimes(2);
    svc.stop();
    svc.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(contextUsage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    svc.start(); // can be restarted
    expect(vi.getTimerCount()).toBe(2);
    svc.stop();
  });

  it('the 5-minute tick does nothing while no client is attached; the next attach refreshes at once when stale', async () => {
    const { session, contextUsage } = stub();
    let clients = 0;
    const svc = new StatsService({ session: () => session, emit: () => {}, hasClients: () => clients > 0 });
    svc.start();
    await vi.advanceTimersByTimeAsync(1_500 + 5 * 60_000);
    expect(contextUsage).toHaveBeenCalledTimes(0); // both ticks skipped
    clients = 1;
    svc.onAttach(); // never refreshed: stale
    await vi.advanceTimersByTimeAsync(0);
    expect(contextUsage).toHaveBeenCalledTimes(1);
    svc.onAttach(); // fresh now: no second pass
    await vi.advanceTimersByTimeAsync(0);
    expect(contextUsage).toHaveBeenCalledTimes(1);
    clients = 0;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(contextUsage).toHaveBeenCalledTimes(1);
    clients = 1;
    svc.onAttach(); // older than 5 minutes
    await vi.advanceTimersByTimeAsync(0);
    expect(contextUsage).toHaveBeenCalledTimes(2);
    svc.stop();
  });

  it('a refresh that finishes after stop() publishes nothing', async () => {
    let release: () => void = () => {};
    const { session } = stub({ context: () => new Promise((r) => { release = () => r({ used: 1, max: 2, pct: 50 }); }) });
    const { svc, emitted } = make(session);
    const p = svc.refresh();
    svc.stop();
    release();
    await p;
    expect(emitted).toHaveLength(0);
  });

  it('does nothing without a session', async () => {
    const { svc, emitted } = make(null);
    await svc.refresh();
    expect(emitted).toHaveLength(0);
  });

  it('stats are never in the hub history, and a new socket can be given current()', async () => {
    const hub = new EventHub();
    const { session } = stub();
    const svc = new StatsService({ session: () => session, emit: (s) => hub.emit({ kind: 'stats', stats: s }, { store: false }) });
    const live: ServerEvent[] = [];
    hub.attach({ send: (d) => live.push(JSON.parse(d) as ServerEvent) });
    await svc.refresh();
    expect(live.some((e) => e.kind === 'stats')).toBe(true);
    const late: ServerEvent[] = [];
    hub.attach({ send: (d) => late.push(JSON.parse(d) as ServerEvent) });
    expect(late).toEqual([{ kind: 'replay', events: [] }]);
    expect(svc.current().context).not.toBeNull();
  });
});
