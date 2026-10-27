import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@nota-bene/shared';
import { TurnLedger, activity } from './turns.ts';

type TurnEnd = Extract<AgentEvent, { t: 'turn-end' }>;
const end = (answers: TurnEnd['answers'], stop: TurnEnd['stop'] = 'done'): TurnEnd => ({ t: 'turn-end', stop, secs: 0, answers, queued: 0 });

describe('TurnLedger: one send', () => {
  it('queued → running → answered; waiting counts queued and running sends', () => {
    const t = new TurnLedger();
    t.sent('a');
    expect(t.state('a')).toBe('queued');
    expect(t.waiting()).toBe(1);
    expect(t.running('a')).toBe(true);
    expect(t.state('a')).toBe('running');
    expect(t.waiting()).toBe(1);
    t.turnEnd(end(['a']));
    expect(t.state('a')).toBe('answered');
    expect(t.waiting()).toBe(0);
  });

  it('a failed turn-end settles its sends as failed; an interrupted one as answered', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.sent('b'); t.running('b');
    t.turnEnd(end(['a'], 'failed'));
    t.turnEnd(end(['b'], 'interrupted'));
    expect(t.state('a')).toBe('failed');
    expect(t.state('b')).toBe('answered');
  });

  it('a send the server could not hand over fails: from queued, or from running', () => {
    const t = new TurnLedger();
    t.sent('a');
    t.failed('a');
    expect(t.state('a')).toBe('failed');
    t.sent('b'); t.running('b');
    t.failed('b');
    expect(t.state('b')).toBe('failed');
    expect(t.waiting()).toBe(0);
  });

  it('failed() with no id fails every waiting send and leaves settled ones alone', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.sent('b');
    t.sent('c'); t.running('c'); t.turnEnd(end(['c']));
    t.failed();
    expect([t.state('a'), t.state('b'), t.state('c')]).toEqual(['failed', 'failed', 'answered']);
  });

  it('cancelled: a waiting send is cancelled and no longer waits', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.sent('b'); t.running('b');
    t.cancelled('b');
    expect(t.state('b')).toBe('cancelled');
    expect(t.waiting()).toBe(1);
  });

  it('"all" answers every waiting send; "none" answers nothing', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.sent('b');
    t.turnEnd(end('none'));
    expect(t.waiting()).toBe(2);
    t.turnEnd(end('all', 'failed'));
    expect([t.state('a'), t.state('b')]).toEqual(['failed', 'failed']);
  });
});

describe('TurnLedger: illegal steps throw (programmer errors)', () => {
  it('a known id cannot be sent again', () => {
    const t = new TurnLedger();
    t.sent('a');
    expect(() => t.sent('a')).toThrow(/already known/);
    t.running('a'); t.turnEnd(end(['a']));
    expect(() => t.sent('a')).toThrow(/already known/);
  });

  it('running an id we never registered, or running a send twice', () => {
    const t = new TurnLedger();
    expect(() => t.running('nope')).toThrow(/unknown send/);
    t.sent('a'); t.running('a');
    expect(() => t.running('a')).toThrow(/already running/);
  });
});

describe('TurnLedger: what a real CLI does is tolerated, never thrown', () => {
  it('T1: a turn-end naming an id the ledger never saw (synthetic turns, a send from before a restart) is ignored', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    expect(() => t.turnEnd(end(['ghost']))).not.toThrow();
    expect(t.state('ghost')).toBeUndefined();
    expect(t.waiting()).toBe(1);
  });

  it('T2: a turn-end naming an already settled id (after "all", a cancel, a reset, or named twice) keeps the first settlement', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.sent('b'); t.running('b');
    t.sent('c'); t.running('c');
    t.turnEnd(end('all', 'failed')); // an error naming none answers all
    t.turnEnd(end(['a'])); // the CLI later answers it anyway
    expect(t.state('a')).toBe('failed');
    t.sent('d'); t.running('d');
    t.cancelled('d');
    t.turnEnd(end(['d']));
    expect(t.state('d')).toBe('cancelled');
    t.sent('e'); t.running('e');
    t.turnEnd(end(['e']));
    t.turnEnd(end(['e'], 'failed')); // answered twice
    expect(t.state('e')).toBe('answered');
  });

  it('T3: running a send that was settled while it waited for its turn (agent died, "all", reset) is tolerated: false, it stays settled', () => {
    const t = new TurnLedger();
    t.sent('a');
    t.failed(); // the agent died while 'a' waited behind a forced send's interrupt
    expect(t.running('a')).toBe(false);
    expect(t.state('a')).toBe('failed');
    expect(t.waiting()).toBe(0);
  });

  it('T4: cancelled / failed naming an unknown or a settled id is ignored', () => {
    const t = new TurnLedger();
    t.cancelled('ghost');
    t.failed('ghost'); // a command whose agent could not even start: never registered
    t.sent('a'); t.running('a'); t.turnEnd(end(['a']));
    t.cancelled('a');
    t.failed('a');
    expect(t.state('a')).toBe('answered');
    expect(t.state('ghost')).toBeUndefined();
  });
});

describe('TurnLedger: store and arm', () => {
  it('a normal turn-end is stored and arms idle compaction', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    expect(t.turnEnd(end(['a']))).toEqual({ store: true, arm: true });
  });

  it("a command's own result never arms, once: a later result naming the same id is a normal one", () => {
    const t = new TurnLedger();
    t.sent('c', { command: 'compact' }); t.running('c');
    expect(t.turnEnd(end(['c'], 'failed'))).toEqual({ store: true, arm: false });
    expect(t.turnEnd(end(['c']))).toEqual({ store: true, arm: true });
  });

  it('a cancelled command still counts as a command when its result comes', () => {
    const t = new TurnLedger();
    t.sent('c', { command: 'compact' }); t.running('c');
    t.cancelled('c');
    expect(t.turnEnd(end(['c']))).toEqual({ store: true, arm: false });
  });

  it('a turn that compacted does not arm; the next one does', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.compactBoundary();
    expect(t.turnEnd(end(['a']))).toEqual({ store: true, arm: false });
    t.sent('b'); t.running('b');
    expect(t.turnEnd(end(['b']))).toEqual({ store: true, arm: true });
  });

  it("/clear: the reset clears waiting; the clear's own result after it is not stored and does not arm", () => {
    const t = new TurnLedger();
    t.sent('c', { command: 'clear' }); t.running('c');
    t.reset();
    expect(t.waiting()).toBe(0);
    expect(t.state('c')).toBe('answered');
    expect(t.turnEnd(end(['c']))).toEqual({ store: false, arm: false });
    expect(t.state('c')).toBe('answered'); // T2
    t.sent('a'); t.running('a');
    expect(t.turnEnd(end(['a']))).toEqual({ store: true, arm: true }); // only the one result after the reset
  });

  it('a reset with no /clear sent (the CLI leaving plan mode with a cleared context): the next result is stored', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.reset();
    expect(t.turnEnd(end(['a']))).toEqual({ store: true, arm: true });
  });

  it('a /compact after a /clear, or a user turn, ends the pending clear', () => {
    const t = new TurnLedger();
    t.sent('c', { command: 'clear' }); t.running('c');
    t.sent('k', { command: 'compact' }); t.running('k');
    t.reset();
    expect(t.turnEnd(end('none')).store).toBe(true);
    t.sent('c2', { command: 'clear' }); t.running('c2');
    t.reset();
    t.userTurn();
    expect(t.turnEnd(end('none')).store).toBe(true);
  });

  it('clear() forgets every send and flag (a switch)', () => {
    const t = new TurnLedger();
    t.sent('c', { command: 'clear' }); t.running('c');
    t.compactBoundary();
    t.clear();
    expect(t.waiting()).toBe(0);
    expect(t.state('c')).toBeUndefined();
    t.sent('c'); // known no more
    t.running('c');
    t.reset(); // no clear pending any more
    expect(t.turnEnd(end(['c']))).toEqual({ store: true, arm: true });
  });
});

describe('activity (derived, R-M7-17)', () => {
  it('idle with nothing waiting; turn while a send waits; asking while a permission waits', () => {
    const t = new TurnLedger();
    const perms = { n: 0, pending() { return this.n; } };
    expect(activity(t, perms)).toBe('idle');
    t.sent('a');
    expect(activity(t, perms)).toBe('turn');
    perms.n = 2;
    expect(activity(t, perms)).toBe('asking');
    t.failed('a');
    expect(activity(t, perms)).toBe('asking'); // a sub-agent may ask with no send of ours waiting
    perms.n = 0;
    expect(activity(t, perms)).toBe('idle');
  });
});

describe('TurnLedger: failure', () => {
  it('failure: the server-made failed turn-end (a dead agent: all; a send it could not hand over: that id), applied', () => {
    const t = new TurnLedger();
    t.sent('a'); t.running('a');
    t.sent('b');
    expect(t.failure(new Error('gone'), 'b')).toEqual({ t: 'turn-end', stop: 'failed', secs: 0, error: 'gone', answers: ['b'], queued: 0 });
    expect([t.state('a'), t.state('b')]).toEqual(['running', 'failed']);
    expect(t.failure('')).toEqual({ t: 'turn-end', stop: 'failed', secs: 0, answers: 'all', queued: 0 });
    expect(t.state('a')).toBe('failed');
  });
});
