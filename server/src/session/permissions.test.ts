import { describe, expect, it } from 'vitest';
import type { EmitInput } from '../hub.ts';
import { PermissionBroker } from './permissions.ts';

function make() {
  const events: EmitInput[] = [];
  const b = new PermissionBroker({ emit: (ev) => events.push(ev) });
  let gen = 0;
  return { b, events, gen: () => gen, bump: () => { gen++; } };
}
const idOf = (events: EmitInput[]) => (events.find((e) => e.kind === 'permission') as { id: string }).id;

describe('PermissionBroker', () => {
  it('open → answered: the ask is shown, the answer resolves it and is announced', async () => {
    const { b, events, gen } = make();
    const p = b.ask(gen, 0)('Bash', { command: 'ls' }, new AbortController().signal);
    expect(b.pending()).toBe(1);
    const id = idOf(events);
    expect(events).toEqual([{ kind: 'permission', id, toolName: 'Bash', input: { command: 'ls' } }]);
    b.answer(id, true);
    expect(await p).toBe(true);
    expect(b.pending()).toBe(0);
    expect(events[1]).toEqual({ kind: 'permission-done', id, allow: true });
  });

  it('open → aborted: the agent withdraws the ask', async () => {
    const { b, events, gen } = make();
    const ac = new AbortController();
    const p = b.ask(gen, 0)('Bash', {}, ac.signal);
    ac.abort();
    expect(await p).toBe(false);
    expect(b.pending()).toBe(0);
    expect(events[1]).toMatchObject({ kind: 'permission-done', allow: false });
  });

  it('an already aborted signal: shown, then aborted at once', async () => {
    const { b, events, gen } = make();
    const ac = new AbortController();
    ac.abort();
    expect(await b.ask(gen, 0)('Bash', {}, ac.signal)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['permission', 'permission-done']);
    expect(b.pending()).toBe(0);
  });

  it('an ask from an old generation is denied at once and never shown', async () => {
    const { b, events, gen, bump } = make();
    const ask = b.ask(gen, 0);
    bump();
    expect(await ask('Bash', {}, new AbortController().signal)).toBe(false);
    expect(events).toEqual([]);
    expect(b.pending()).toBe(0);
  });

  it('denyAll aborts every open ask; it is announced only while their generation is current', async () => {
    const { b, events, gen, bump } = make();
    const p1 = b.ask(gen, 0)('A', {}, new AbortController().signal);
    const p2 = b.ask(gen, 0)('B', {}, new AbortController().signal);
    b.denyAll(); // the agent died: same generation, the UI hears it
    expect(await Promise.all([p1, p2])).toEqual([false, false]);
    expect(events.filter((e) => e.kind === 'permission-done')).toHaveLength(2);
    const p3 = b.ask(gen, 0)('C', {}, new AbortController().signal);
    bump(); // a switch or close: the old session's asks end silently
    b.denyAll();
    expect(await p3).toBe(false);
    expect(events.filter((e) => e.kind === 'permission-done')).toHaveLength(2);
    expect(b.pending()).toBe(0);
  });

  it('tolerated: an answer for an unknown or a settled ask (a second socket, a late click after the abort) is ignored', async () => {
    const { b, events, gen } = make();
    const ac = new AbortController();
    const p = b.ask(gen, 0)('Bash', {}, ac.signal);
    const id = idOf(events);
    b.answer(id, true);
    b.answer(id, false); // the other tab
    ac.abort(); // the listener is gone with the answer
    b.answer('ghost', true);
    expect(await p).toBe(true);
    expect(events.filter((e) => e.kind === 'permission-done')).toEqual([{ kind: 'permission-done', id, allow: true }]);
  });
});
