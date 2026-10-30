import type { AgentSession, SendImage } from '../agent/types.ts';

type QueueOptions = {
  gen: () => number;
  /** the agent when the send runs (a crash while queued starts a new one); throws when none may start */
  agent: () => AgentSession;
  /** the send is handed over now */
  running: (id: string) => void;
  /** the agent is still the slot's (an interrupt that fails on one that died is no news) */
  isCurrent: (a: AgentSession) => boolean;
  /** a forced send waits this long for the interrupt, no longer (a stuck CLI must not hold the queue) */
  interruptMs: number;
  report: (where: string, e: unknown) => void;
  /** the user event is already out: answer it or the feed waits forever */
  fail: (e: unknown, id: string) => void;
};

/**
 * The user's sends, handed to the agent one after the other, so that a forced send's interrupt lands before it and
 * after the sends made before it. A send queued in one generation is dropped silently once the generation moved
 * (a switch or a close began while it waited), checked after every await.
 */
export class SendQueue {
  private chain: Promise<void> = Promise.resolve();
  private readonly o: QueueOptions;

  constructor(o: QueueOptions) {
    this.o = o;
  }

  /**
   * `lead`: asked at the hand-over, right before the agent gets the text, for what goes in front of it (the `! cmd` runs since the
   * agent's last message); its `restore` is called when the hand-over throws, so nothing is lost with the failed send.
   */
  push(m: { id: string; text: string; force?: boolean; images?: SendImage[]; lead?: (text: string) => { text: string; restore(): void } }): void {
    const { gen, agent, report } = this.o;
    const g = gen();
    this.chain = this.chain.then(async () => {
      if (g !== gen()) return;
      try {
        // a stale interrupt rejection must neither toast nor start an agent; no-op when idle
        if (m.force) {
          const a0 = agent();
          let raced = false; // lost the race or the agent died: the late rejection is no news
          const stopped = a0.interrupt().catch((e) => { if (!raced && g === gen() && this.o.isCurrent(a0)) report('interrupt', e); });
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([stopped, new Promise<void>((r) => { timer = setTimeout(r, this.o.interruptMs); timer.unref(); })]);
          clearTimeout(timer);
          raced = true;
        }
        if (g !== gen()) return;
        const a = agent();
        this.o.running(m.id);
        const led = m.lead?.(m.text);
        try {
          a.send({ uuid: m.id, text: led?.text ?? m.text, priority: m.force ? 'now' : 'next', ...(m.images?.length ? { images: m.images } : {}) });
        } catch (e) {
          led?.restore();
          throw e;
        }
      } catch (e) {
        if (g !== gen()) return;
        report('send', e);
        this.o.fail(e, m.id);
      }
    });
  }

  /** a new session: a chain stuck in the old one's interrupt must not hold the new one */
  reset(): void {
    this.chain = Promise.resolve();
  }

  /** resolves when everything queued so far has run (tests) */
  idle(): Promise<void> {
    return this.chain;
  }
}
