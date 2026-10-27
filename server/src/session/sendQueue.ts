import type { AgentSession, SendImage } from '../agent/types.ts';

type QueueOptions = {
  gen: () => number;
  /** the agent when the send runs (a crash while queued starts a new one); throws when none may start */
  agent: () => AgentSession;
  /** the send is handed over now */
  running: (id: string) => void;
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

  push(m: { id: string; text: string; force?: boolean; images?: SendImage[] }): void {
    const { gen, agent, report } = this.o;
    const g = gen();
    this.chain = this.chain.then(async () => {
      if (g !== gen()) return;
      try {
        // a stale interrupt rejection must neither toast nor start an agent; no-op when idle
        if (m.force) await agent().interrupt().catch((e) => { if (g === gen()) report('interrupt', e); });
        if (g !== gen()) return;
        const a = agent();
        this.o.running(m.id);
        a.send({ uuid: m.id, text: m.text, priority: m.force ? 'now' : 'next', ...(m.images?.length ? { images: m.images } : {}) });
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
