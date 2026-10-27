import type { ServerEvent } from '@nota-bene/shared';

type Sock = { send(data: string): void };

type Unstamped<E> = E extends { ts: number } ? Omit<E, 'ts'> & { ts?: number } : E;
export type EmitInput = Exclude<Unstamped<ServerEvent>, { kind: 'replay' }>;

export class EventHub {
  private history: ServerEvent[] = [];
  /** archived segments of the current conversation (R-M7-4): every replay carries it while it is > 0 */
  private earlier = 0;
  /** events of the history that a cut already wrote to the archive (kept for a reload, never written twice) */
  private archived = new WeakSet<ServerEvent>();
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
      sock.send(this.replayFrame());
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
  reset(events: ServerEvent[] = [], o: { earlier?: number } = {}): void {
    this.history = [...events];
    this.earlier = o.earlier ?? 0;
    this.archived = new WeakSet();
    const frame = this.replayFrame();
    for (const s of [...this.socks]) {
      try {
        s.send(frame);
      } catch {
        this.socks.delete(s);
      }
    }
  }

  /**
   * A compaction (R-M7-1, R-M7-2): every event before the last stored `compacted` event (the boundary, which stays
   * with everything after it) goes to `archive` as one segment, which returns its number (the new `earlier`); when
   * it throws, nothing changes. Segments never overlap: an event already written by an earlier cut is not written
   * again. Some events are archived AND kept in the hub, in their order before the boundary, because a reloaded page
   * still needs them: the last `session` event (the header), an ask with no answer yet, the events of a task not
   * done yet, and whatever `keep` says (the façade: a send still waiting, so a reload mid-turn shows the turn
   * running; the archived copy is the same event, same id, so a page that loads the segment can dedupe it). Returns
   * what was written. No live socket hears of a cut: their feeds already hold all of it.
   */
  cut(o: { keep?: (ev: ServerEvent) => boolean; archive?: (events: ServerEvent[]) => number } = {}): ServerEvent[] {
    const at = this.history.findLastIndex((ev) => ev.kind === 'agent' && ev.e.t === 'compacted');
    if (at <= 0) return [];
    const before = this.history.slice(0, at);
    const lastSession = before.findLastIndex((ev) => ev.kind === 'session');
    const answered = new Set(before.flatMap((ev) => (ev.kind === 'permission-done' ? [ev.id] : [])));
    const doneTasks = new Set(before.flatMap((ev) => (ev.kind === 'agent' && ev.e.t === 'task' && ev.e.phase === 'done' ? [ev.e.id] : [])));
    const stays = (ev: ServerEvent, i: number) => i === lastSession
      || (ev.kind === 'permission' && !answered.has(ev.id))
      || (ev.kind === 'agent' && ev.e.t === 'task' && !doneTasks.has(ev.e.id))
      || (o.keep?.(ev) ?? false);
    const kept = before.filter(stays);
    const moved = before.filter((ev) => !this.archived.has(ev));
    if (moved.length) {
      const n = o.archive?.(moved) ?? 0;
      if (n > 0) this.earlier = n;
      for (const ev of kept) this.archived.add(ev);
    }
    this.history = [...kept, ...this.history.slice(at)];
    return moved;
  }

  private replayFrame(): string {
    return JSON.stringify({ kind: 'replay', events: this.history, ...(this.earlier > 0 ? { earlier: this.earlier } : {}) });
  }

  private stamp(ev: EmitInput): ServerEvent {
    if (ev.kind === 'session' || ev.kind === 'resumed' || ev.kind === 'server-error' || ev.kind === 'send-refused' || ev.kind === 'comments' || ev.kind === 'stats' || ev.kind === 'mode' || ev.kind === 'idle-compact' || ev.kind === 'hello') return ev;
    return { ...ev, ts: ev.ts ?? Date.now() } as ServerEvent;
  }
}
