import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../agent/types.ts';
import { SendQueue } from './sendQueue.ts';

function make(o: { interrupt?: () => Promise<void>; sendThrows?: boolean } = {}) {
  const log: string[] = [];
  const errors: string[] = [];
  let gen = 0;
  const agent = {
    interrupt: () => { log.push('interrupt'); return o.interrupt ? o.interrupt() : Promise.resolve(); },
    send: (m: { uuid: string; priority: string }) => { if (o.sendThrows) throw new Error('send failed'); log.push(`send ${m.uuid}:${m.priority}`); },
  } as unknown as AgentSession;
  const q = new SendQueue({
    gen: () => gen,
    agent: () => agent,
    running: (id) => log.push(`running ${id}`),
    report: (w, e) => errors.push(`${w}: ${(e as Error).message}`),
    fail: (e, id) => log.push(`fail ${id}: ${(e as Error).message}`),
  });
  return { q, log, errors, bump: () => { gen++; } };
}

describe('SendQueue', () => {
  it('sends in order; a forced send interrupts first and goes "now"', async () => {
    const { q, log } = make();
    q.push({ id: 'A', text: 'a' });
    q.push({ id: 'B', text: 'b', force: true });
    q.push({ id: 'C', text: 'c' });
    await q.idle();
    expect(log).toEqual(['running A', 'send A:next', 'interrupt', 'running B', 'send B:now', 'running C', 'send C:next']);
  });

  it('a failed interrupt is reported, the send still goes', async () => {
    const { q, log, errors } = make({ interrupt: () => Promise.reject(new Error('nope')) });
    q.push({ id: 'A', text: 'a', force: true });
    await q.idle();
    expect(errors).toEqual(['interrupt: nope']);
    expect(log).toContain('send A:now');
  });

  it('a send the agent refuses is reported and answered with a failure', async () => {
    const { q, log, errors } = make({ sendThrows: true });
    q.push({ id: 'A', text: 'a' });
    await q.idle();
    expect(errors).toEqual(['send: send failed']);
    expect(log).toEqual(['running A', 'fail A: send failed']);
  });

  it('a generation change (switch, close) drops what is queued, also while an interrupt is in flight, silently', async () => {
    let release!: () => void;
    const { q, log, errors, bump } = make({ interrupt: () => new Promise<void>((_, r) => { release = () => r(new Error('Query closed')); }) });
    q.push({ id: 'A', text: 'a', force: true });
    q.push({ id: 'B', text: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    bump();
    release();
    await q.idle();
    expect(log).toEqual(['interrupt']);
    expect(errors).toEqual([]);
  });

  it('reset: a new chain; the old one cannot hold it', async () => {
    const { q, log, bump } = make({ interrupt: () => new Promise<void>(() => {}) });
    q.push({ id: 'A', text: 'a', force: true }); // stuck forever
    await new Promise((r) => setTimeout(r, 0));
    bump();
    q.reset();
    q.push({ id: 'B', text: 'b' });
    await q.idle();
    expect(log).toEqual(['interrupt', 'running B', 'send B:next']);
  });
});
