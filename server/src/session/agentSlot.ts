import type { AgentSession } from '../agent/types.ts';
import type { PhaseKind } from './phase.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

type SlotOptions = {
  /** a new agent for generation `g` (its asks carry `g`) */
  start: (g: number) => AgentSession;
  /** the agent's message loop; it checks isCurrent(a, g) before acting on anything */
  pump: (a: AgentSession, g: number) => Promise<void>;
  onError: (where: string, e: unknown) => void;
};

/**
 * The one running agent and its message loop, and the generation. The generation is bumped when a session is torn
 * down (switch, close): everything an agent can trigger later (its messages, its permission asks, a queued send, a
 * mode or title answer) carries the generation it started in and is dropped when that is no longer current, so
 * nothing of the old session reaches the new one's sockets.
 */
export class AgentSlot {
  private g = 0;
  private a: AgentSession | null = null;
  private loop: Promise<void> | null = null;
  private readonly o: SlotOptions;

  constructor(o: SlotOptions) {
    this.o = o;
  }

  get gen(): number {
    return this.g;
  }

  get agent(): AgentSession | null {
    return this.a;
  }

  isCurrent(a: AgentSession, g: number): boolean {
    return g === this.g && this.a === a;
  }

  /** The running agent; with none, starts one, which only a live phase may (mid-switch the switch starts it). */
  ensure(phase: PhaseKind): AgentSession {
    if (this.a) return this.a;
    if (phase !== 'live') throw new Error(`the session is ${phase}`);
    const g = this.g;
    const a = this.o.start(g);
    this.a = a;
    this.loop = this.o.pump(a, g);
    return a;
  }

  /** A busy restart stops the turn first, best effort and capped at `waitMs` (a stuck CLI must not hold it). */
  async stopTurn(waitMs: number): Promise<void> {
    const a = this.a;
    if (!a) return;
    let raced = false; // lost the race: the late rejection (the CLI's "Query closed" on close) is no news
    const stopped = a.interrupt().catch((e) => { if (!raced) this.o.onError('interrupt', e); });
    await Promise.race([stopped, sleep(waitMs)]);
    raced = true;
  }

  /** gen++, let go of the agent (`release` runs before it is closed), wait for its loop up to `waitMs` */
  async teardown(waitMs: number, release?: () => void): Promise<void> {
    const loop = this.detach(release);
    if (loop) await Promise.race([loop, sleep(waitMs)]);
  }

  /** teardown without the wait (close() is synchronous) */
  close(release?: () => void): void {
    void this.detach(release);
  }

  /** The current agent's loop ended or threw: the slot is emptied in the same generation, the agent closed. */
  died(a: AgentSession): void {
    if (this.a !== a) throw new Error('died: not the current agent');
    this.a = null;
    this.loop = null;
    this.closeAgent(a);
  }

  private detach(release?: () => void): Promise<void> | null {
    this.g++;
    const a = this.a;
    const loop = this.loop;
    this.a = null; // its pump then ends quietly instead of reporting a dead agent
    this.loop = null;
    release?.();
    if (a) this.closeAgent(a);
    return loop;
  }

  private closeAgent(a: AgentSession): void {
    try { a.close(); } catch (e) { this.o.onError('agent-close', e); }
  }
}
