import type { ServerEvent } from '@nota-bene/shared';
import type { HistoryArchive } from '../archive.ts';
import type { EventHub } from '../hub.ts';

type Cut = {
  hub: EventHub; archive: HistoryArchive;
  /** the conversation's own id (SessionIdentity.ownId) */
  id: () => string | null;
  /** a user's send still waiting (TurnLedger.inFlight): its event stays in the replay */
  inFlight: (sendId: string) => boolean;
  report: (where: string, e: unknown) => void;
};

/**
 * The archive side of a compaction (R-M7-1…3). `cut` runs in the pump right after the `compacted` event reached
 * the hub, in the same synchronous step that checked the agent's generation, so the id it reads is the one current
 * when the boundary arrived (after a /clear: the new id; a switch's old agent never gets this far). No id of its own
 * yet (a new session before its init, a fork before its new id): nothing is cut, the history stays whole. A failed
 * write is reported and cuts nothing; the pump goes on.
 */
export function archiveCut(o: Cut): { cut(): void; earlier(): number } {
  return {
    cut() {
      const id = o.id();
      if (!id) return;
      try {
        o.hub.cut({ keep: (ev: ServerEvent) => ev.kind === 'user' && o.inFlight(ev.id), archive: (evs) => o.archive.append(id, evs) });
      } catch (e) {
        o.report('archive', e);
      }
    },
    /** the segments of the current conversation, for its replay; 0 when unreadable (reported) */
    earlier() {
      const id = o.id();
      if (!id) return 0;
      try {
        return o.archive.count(id);
      } catch (e) {
        o.report('archive', e);
        return 0;
      }
    },
  };
}
