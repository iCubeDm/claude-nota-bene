import { describe, expect, it } from 'vitest';
import type { ProviderSession as AgentSession } from '../agent/types.ts';
import { AgentSlot } from './agentSlot.ts';
import type { PhaseKind } from './phase.ts';

/** A stand-in agent: `end()` ends its message loop; close() is recorded (and can be made to throw). */
function fakeAgent(log: string[], name: string, o: { closeThrows?: boolean } = {}) {
  let end!: () => void;
  const ended = new Promise<void>((r) => { end = r; });
  const a = {
    messages: (async function* () { await ended; })(),
    send() {}, interrupt: async () => {}, fileSuggestions: async () => [], setPermissionMode: async () => {}, supportedModels: async () => [], supportedCommands: async () => [], setModel: async () => {}, setEffort: async () => {},
    contextUsage: async () => ({ used: 0, max: 1, pct: 0 }), usage: async () => ({ cost: null, limits: null }),
    stopTask: async () => {}, backgroundTask: async () => false, taskOutput: async () => ({ output: '', totalBytes: 0, truncated: false }),
    close() { log.push(`close ${name}`); if (o.closeThrows) throw new Error('close failed'); },
  } as AgentSession;
  return { a, end, ended };
}

function make(o: { closeThrows?: boolean; loopNeverEnds?: boolean } = {}) {
  const log: string[] = [];
  const errors: string[] = [];
  const agents: ReturnType<typeof fakeAgent>[] = [];
  const phase = { kind: 'live' as PhaseKind };
  const slot: AgentSlot = new AgentSlot({
    start: (g) => { const f = fakeAgent(log, `a${agents.length + 1}`, o); agents.push(f); log.push(`start g${g}`); return f.a; },
    pump: async (a, g) => {
      log.push(`pump g${g} current=${slot.isCurrent(a, g)}`);
      if (o.loopNeverEnds) return new Promise<void>(() => {});
      const f = agents.find((x) => x.a === a)!;
      await f.ended;
      log.push(`loop end g${g}`);
    },
    onError: (where, e) => errors.push(`${where}: ${(e as Error).message}`),
    phase: () => phase.kind,
  });
  return { slot, log, errors, agents, phase };
}

describe('AgentSlot', () => {
  it('ensure starts one agent in the current generation and pumps it; later calls return the same agent', () => {
    const { slot, log } = make();
    expect(slot.agent).toBeNull();
    const a = slot.ensure();
    expect(slot.ensure()).toBe(a);
    expect(slot.agent).toBe(a);
    expect(slot.gen).toBe(0);
    expect(slot.isCurrent(a, 0)).toBe(true);
    expect(log).toEqual(['start g0', 'pump g0 current=true']);
  });

  it('ensure returns a running agent in any phase, but starts none unless live', () => {
    const { slot, log, phase } = make();
    const a = slot.ensure();
    phase.kind = 'switching';
    expect(slot.ensure()).toBe(a);
    slot.close();
    expect(() => slot.ensure()).toThrow('the session is switching');
    phase.kind = 'closed';
    expect(() => slot.ensure()).toThrow('the session is closed');
    expect(log.filter((l) => l.startsWith('start'))).toHaveLength(1);
  });

  it('teardown: gen++, the slot is empty, release runs before the close, then it waits for the old loop', async () => {
    const { slot, log, agents } = make();
    const a = slot.ensure();
    const done = slot.teardown(1000, () => log.push(`release gen=${slot.gen} agent=${slot.agent}`));
    expect(slot.gen).toBe(1);
    expect(slot.agent).toBeNull();
    expect(slot.isCurrent(a, 0)).toBe(false);
    let finished = false;
    void done.then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toBe(false); // the loop has not ended
    agents[0]!.end();
    await done;
    expect(log.slice(2)).toEqual(['release gen=1 agent=null', 'close a1', 'loop end g0']);
    slot.ensure();
    expect(log.at(-2)).toBe('start g1');
  });

  it('teardown does not wait past waitMs for a loop that never ends; with no agent it only bumps gen', async () => {
    const { slot } = make({ loopNeverEnds: true });
    await slot.teardown(5);
    expect(slot.gen).toBe(1);
    slot.ensure();
    const t0 = Date.now();
    await slot.teardown(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(slot.gen).toBe(2);
  });

  it('close: synchronous teardown without the wait; a close that throws is reported', () => {
    const { slot, log, errors } = make({ closeThrows: true });
    slot.ensure();
    slot.close(() => log.push('release'));
    expect(slot.gen).toBe(1);
    expect(slot.agent).toBeNull();
    expect(log.slice(2)).toEqual(['release', 'close a1']);
    expect(errors).toEqual(['agent-close: close failed']);
    slot.close(); // idempotent apart from gen
    expect(slot.gen).toBe(2);
  });

  it('died: the slot is emptied in the same generation and the agent closed; the next ensure starts a new one', () => {
    const { slot, log } = make();
    const a = slot.ensure();
    slot.died(a);
    expect(slot.agent).toBeNull();
    expect(slot.gen).toBe(0);
    expect(log.at(-1)).toBe('close a1');
    expect(slot.ensure()).not.toBe(a);
  });

  it('died for an agent that is not the current one is a programmer error', () => {
    const { slot } = make();
    const a = slot.ensure();
    slot.close();
    expect(() => slot.died(a)).toThrow(/not the current agent/);
  });

  it('stopTurn: interrupts the agent, waits up to waitMs; a rejection inside the wait is reported, a later one is not', async () => {
    const { slot, errors } = make();
    expect(await slot.stopTurn(10)).toBeUndefined(); // no agent: nothing
    const a = slot.ensure();
    let reject!: (e: Error) => void;
    let calls = 0;
    a.interrupt = () => { calls++; return new Promise<void>((_, r) => { reject = r; }); };
    const p = slot.stopTurn(1000);
    reject(new Error('early'));
    await p;
    expect(errors).toEqual(['interrupt: early']);
    const t0 = Date.now();
    await slot.stopTurn(20); // a stuck CLI does not hold it
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    reject(new Error('Query closed'));
    await new Promise((r) => setTimeout(r, 5));
    expect(errors).toEqual(['interrupt: early']);
    expect(calls).toBe(2);
  });
});
