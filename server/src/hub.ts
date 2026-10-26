import type { ServerEvent } from '@nota-bene/shared';

type Sock = { send(data: string): void };

type Unstamped<E> = E extends { ts: number } ? Omit<E, 'ts'> & { ts?: number } : E;
export type EmitInput = Exclude<Unstamped<ServerEvent>, { kind: 'replay' }>;

export class EventHub {
  private history: ServerEvent[] = [];
  private socks = new Set<Sock>();

  emit(ev: EmitInput, o: { store?: boolean } = {}): void {
    const stamped = this.stamp(ev);
    if (o.store ?? true) this.history.push(stamped);
    const frame = JSON.stringify(stamped);
    for (const s of [...this.socks]) {
      try {
        s.send(frame);
      } catch {
        this.socks.delete(s);
      }
    }
  }

  /** Attached sockets. */
  clients(): number {
    return this.socks.size;
  }

  attach(sock: Sock): () => void {
    try {
      sock.send(JSON.stringify({ kind: 'replay', events: this.history }));
      this.socks.add(sock);
    } catch {
      // socket already dead: nothing to attach
    }
    return () => void this.socks.delete(sock);
  }

  /**
   * Replaces the history and sends it to every connected socket as a new replay (the web reducer rebuilds its feed
   * from a replay, so `reset()` empties every feed). Used when the conversation changes under the sockets: a switch,
   * a restart, the startup resume.
   */
  reset(events: ServerEvent[] = []): void {
    this.history = [...events];
    const frame = JSON.stringify({ kind: 'replay', events: this.history });
    for (const s of [...this.socks]) {
      try {
        s.send(frame);
      } catch {
        this.socks.delete(s);
      }
    }
  }

  private stamp(ev: EmitInput): ServerEvent {
    if (ev.kind === 'session' || ev.kind === 'resumed' || ev.kind === 'server-error' || ev.kind === 'send-refused' || ev.kind === 'comments' || ev.kind === 'stats' || ev.kind === 'mode') return ev;
    return { ...ev, ts: ev.ts ?? Date.now() } as ServerEvent;
  }
}
