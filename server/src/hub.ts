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

  attach(sock: Sock): () => void {
    try {
      sock.send(JSON.stringify({ kind: 'replay', events: this.history }));
      this.socks.add(sock);
    } catch {
      // socket already dead: nothing to attach
    }
    return () => void this.socks.delete(sock);
  }

  reset(events: ServerEvent[] = []): void {
    this.history = [...events];
  }

  private stamp(ev: EmitInput): ServerEvent {
    if (ev.kind === 'session' || ev.kind === 'resumed' || ev.kind === 'server-error' || ev.kind === 'comments') return ev;
    return { ...ev, ts: ev.ts ?? Date.now() } as ServerEvent;
  }
}
