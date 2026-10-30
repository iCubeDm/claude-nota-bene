import { reduceTasks, type ServerEvent, type Task } from '@nota-bene/shared';

type Sock = { send(data: string): void };

type Unstamped<E> = E extends { ts: number } ? Omit<E, 'ts'> & { ts?: number } : E;
export type EmitInput = Exclude<Unstamped<ServerEvent>, { kind: 'replay' }>;

export class EventHub {
  private history: ServerEvent[] = [];
  /** archived segments of the current conversation (R-M7-4): every replay carries it while it is > 0 */
  private earlier = 0;
  /**
   * Events of the history that a cut already wrote to the archive (kept for a reload, never written twice).
   * Invariant: an archived event is never put back into the hub by value. The marks are by reference, and `reset()`
   * clears them (every reset brings new objects: a transcript replay holds only what came after the last compaction,
   * which no segment has); a copy of an archived event put back would be written into a segment again.
   */
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

  /**
   * What the history says of the Agent call `tool`: whether a task started by it is still live (a task event with
   * `call`, not yet done) and whether its tool_result has arrived. The subagent route's `running` and its cached 404 read it.
   */
  callState(tool: string): { live: boolean; hasResult: boolean } {
    const live = Object.values(reduceTasks({}, { kind: 'replay', events: this.history, ts: 0 } as ServerEvent)).some((t) => t.call === tool && t.status === 'running');
    const hasResult = this.history.some((ev) => ev.kind === 'agent' && ev.e.t === 'tool-update' && ev.e.id === tool);
    return { live, hasResult };
  }

  /** The task `id` as the history replays it (running, or among the last finished); undefined when the server does not know it. */
  task(id: string): Task | undefined {
    return reduceTasks({}, { kind: 'replay', events: this.history, ts: 0 } as ServerEvent)[id];
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
   * still needs them: the last `session` event (the header), an ask with no answer yet, the events of the tasks the state holds, and whatever `keep` says (the façade: a send still waiting, so a reload mid-turn shows the turn
   * running; the archived copy is the same event, same id, so a page that loads the segment can dedupe it). Returns
   * what was written. No live socket hears of a cut: their feeds already hold all of it.
   */
  cut(o: { keep?: (ev: ServerEvent) => boolean; archive?: (events: ServerEvent[]) => number } = {}): ServerEvent[] {
    const at = this.history.findLastIndex((ev) => ev.kind === 'agent' && ev.e.t === 'compacted');
    if (at <= 0) return [];
    const before = this.history.slice(0, at);
    const lastSession = before.findLastIndex((ev) => ev.kind === 'session');
    const answered = new Set(before.flatMap((ev) => (ev.kind === 'permission-done' ? [ev.id] : [])));
    const taskKept = runningTasks(before);
    const stays = (ev: ServerEvent, i: number) => i === lastSession
      || (ev.kind === 'permission' && !answered.has(ev.id))
      || taskKept.has(i)
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
    if (ev.kind === 'session' || ev.kind === 'resumed' || ev.kind === 'server-error' || ev.kind === 'send-refused' || ev.kind === 'shell-out' || ev.kind === 'comments' || ev.kind === 'stats' || ev.kind === 'mode' || ev.kind === 'model' || ev.kind === 'models' || ev.kind === 'commands' || ev.kind === 'idle-compact' || ev.kind === 'hello' || ev.kind === 'occupied' || ev.kind === 'taken-over') return ev;
    return { ...ev, ts: ev.ts ?? Date.now() } as ServerEvent;
  }
}

/**
 * The indexes of the task events a replay needs for the tasks the state holds at the boundary (the running ones and the
 * last few finished): per id, its FIRST `started` (a resume restarts the id with the SendMessage call's id, and the reducer keeps
 * the call of the first start) and, after its last `started`, that `started`, the last `progress` before it ended, the first
 * `done` (the reducer ignores a second end), the last `updated` that names a desc and the last that carries `bg`. That is all the web's
 * reduceTasks reads (a progress overwrites tokens, tool and summary of a running task; an updated with a desc overwrites
 * the desc, one without changes nothing), so the trimmed events replay to the same state. The rest is archived.
 */
function runningTasks(before: ServerEvent[]): Set<number> {
  const live = new Set(Object.keys(reduceTasks({}, { kind: 'replay', events: before, ts: 0 } as ServerEvent)));
  const last = new Map<string, Map<string, number>>(); // id -> phase -> index
  const first = new Map<string, number>(); // id -> index of its first `started`
  before.forEach((ev, i) => {
    if (ev.kind !== 'agent' || ev.e.t !== 'task' || !live.has(ev.e.id)) return;
    const { id, phase } = ev.e;
    if (phase === 'started') {
      if (!first.has(id)) first.set(id, i);
      last.set(id, new Map([[phase, i]]));
    }
    const m = last.get(id);
    if (!m) return;
    if (phase === 'done') {
      if (!m.has('done')) m.set('done', i);
    } else if (phase === 'progress') {
      if (!m.has('done')) m.set(phase, i);
    } else if (phase === 'updated') {
      if (ev.e.desc) m.set('updated', i);
      if (ev.e.bg !== undefined) m.set('updatedBg', i);
    }
  });
  return new Set([...last.values()].flatMap((m) => [...m.values()]).concat([...first.values()]));
}
