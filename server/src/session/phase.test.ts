import { describe, expect, it } from 'vitest';
import { Phase, SwitchError } from './phase.ts';

describe('Phase', () => {
  it('starts live; a switch goes live → switching → live', () => {
    const p = new Phase();
    expect(p.kind).toBe('live');
    expect(p.switching).toBe(false);
    expect(p.beginSwitch()).toBe(true);
    expect(p.kind).toBe('switching');
    expect(p.switching).toBe(true);
    p.endSwitch();
    expect(p.kind).toBe('live');
    expect(p.switching).toBe(false);
  });

  it('a second switch while one runs throws SwitchError("switch")', () => {
    const p = new Phase();
    p.beginSwitch();
    let err: unknown;
    try { p.beginSwitch(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SwitchError);
    expect(err).toMatchObject({ where: 'switch', message: 'a switch is already in progress' });
    expect(p.kind).toBe('switching');
  });

  it('endSwitch with no switch running is a programmer error', () => {
    expect(() => new Phase().endSwitch()).toThrow(/no switch/);
  });

  it('close is final and idempotent; a switch on a closed phase is a no-op returning false', () => {
    const p = new Phase();
    p.close();
    p.close();
    expect(p.kind).toBe('closed');
    expect(p.beginSwitch()).toBe(false);
    expect(p.switching).toBe(false);
    expect(p.kind).toBe('closed');
  });

  it('close during a switch: closed at once, the switch still counts as running until it ends, then stays closed', () => {
    const p = new Phase();
    p.beginSwitch();
    p.close();
    expect(p.kind).toBe('closed');
    expect(p.switching).toBe(true); // busy() and switching() stay true while the switch unwinds (M7-10 test 10)
    expect(() => p.beginSwitch()).toThrow(SwitchError); // the unwinding switch still blocks another
    p.endSwitch();
    expect(p.kind).toBe('closed');
    expect(p.switching).toBe(false);
  });
});
