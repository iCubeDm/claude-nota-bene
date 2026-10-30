import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../agent/types.ts';
import { SendQueue } from './sendQueue.ts';

function make(o: { interrupt?: () => Promise<void>; sendThrows?: boolean; interruptMs?: number } = {}) {
  const log: string[] = [];
  const errors: string[] = [];
  let gen = 0;
  let current = true;
  const agent = {
    interrupt: () => { log.push('interrupt'); return o.interrupt ? o.interrupt() : Promise.resolve(); },
    send: (m: { uuid: string; priority: string }) => { if (o.sendThrows) throw new Error('send failed'); log.push(`send ${m.uuid}:${m.priority}`); },
  } as unknown as AgentSession;
  const q = new SendQueue({
    gen: () => gen,
    agent: () => agent,
    running: (id) => log.push(`running ${id}`),
    isCurrent: () => current,
    interruptMs: o.interruptMs ?? 2000,
    report: (w, e) => errors.push(`${w}: ${(e as Error).message}`),
    fail: (e, id) => log.push(`fail ${id}: ${(e as Error).message}`),
  });
  return { q, log, errors, bump: () => { gen++; }, die: () => { current = false; } };
}

describe('SendQueue lead', () => {
  it('asks for the lead as the text is handed over, once, and sends what it gave', async () => {
    const { q, log } = make();
    const taken: string[] = [];
    q.push({ id: 'A', text: 'a', lead: (t) => (taken.push(t), { text: `LEAD\n\n${t}`, restore: () => log.push('restored') }) });
    await q.idle();
    expect(taken).toEqual(['a']);
    expect(log).toEqual(['running A', 'send A:next']);
  });

  it('a hand-over that throws gives the lead back', async () => {
    const { q, log } = make({ sendThrows: true });
    q.push({ id: 'A', text: 'a', lead: (t) => ({ text: t, restore: () => log.push('restored') }) });
    await q.idle();
    expect(log).toEqual(['running A', 'restored', 'fail A: send failed']);
  });

  it('a send dropped because the session moved on never asks for it', async () => {
    const { q, bump } = make();
    let asked = 0;
    q.push({ id: 'A', text: 'a', lead: (t) => (asked++, { text: t, restore() {} }) });
    bump();
    await q.idle();
    expect(asked).toBe(0);
  });
});

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

  it('an interrupt that never settles does not hold the queue: the forced send goes after the cap', async () => {
    const { q, log } = make({ interrupt: () => new Promise<void>(() => {}), interruptMs: 20 });
    q.push({ id: 'A', text: 'a', force: true });
    q.push({ id: 'B', text: 'b' });
    await q.idle();
    expect(log).toEqual(['interrupt', 'running A', 'send A:now', 'running B', 'send B:next']);
  });

  it('an interrupt that fails because its agent died is not reported (the crash was); the send still goes', async () => {
    let fail!: () => void;
    const { q, log, errors, die } = make({ interrupt: () => new Promise<void>((_, r) => { fail = () => r(new Error('Query closed')); }) });
    q.push({ id: 'A', text: 'a', force: true });
    await new Promise((r) => setTimeout(r, 0));
    die();
    fail();
    await q.idle();
    expect(errors).toEqual([]);
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
