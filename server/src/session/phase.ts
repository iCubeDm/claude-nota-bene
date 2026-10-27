/**
 * A refused switch or restart. Reported as `where: 'switch'`, also when it was refused for being busy (a turn, a
 * permission or another switch in progress): the client ends its "switching" state on exactly this, never on a `busy`
 * error, which may answer some other socket's send or command (M4-10).
 */
export class SwitchError extends Error {
  readonly where: 'busy' | 'switch';
  constructor(where: 'busy' | 'switch', message: string) {
    super(message);
    this.where = where;
  }
}

export type PhaseKind = 'live' | 'switching' | 'closed';

/**
 * The session's global phase (R-M7-11), strict because it is truly exclusive: `live → switching → live`, and
 * `close()` from anywhere, final. A close that lands mid-switch makes the phase `closed` at once, but the switch's
 * own work is still unwinding: `switching` stays true until its `endSwitch()` (busy() and switching() say so, and no
 * other switch may start meanwhile), and the switch then starts no agent.
 */
export class Phase {
  private k: PhaseKind = 'live';
  private inFlight = false;

  get kind(): PhaseKind {
    return this.k;
  }

  /** From beginSwitch() to endSwitch(), also when a close() landed in between. */
  get switching(): boolean {
    return this.inFlight;
  }

  /** live → switching; throws SwitchError('switch', 'a switch is already in progress') while one runs; no-op returning false when closed */
  beginSwitch(): boolean {
    if (this.inFlight) throw new SwitchError('switch', 'a switch is already in progress');
    if (this.k === 'closed') return false;
    this.k = 'switching';
    this.inFlight = true;
    return true;
  }

  /** switching → live (or stays closed) */
  endSwitch(): void {
    if (!this.inFlight) throw new Error('endSwitch: no switch in progress');
    this.inFlight = false;
    if (this.k === 'switching') this.k = 'live';
  }

  /** any → closed; final */
  close(): void {
    this.k = 'closed';
  }
}
