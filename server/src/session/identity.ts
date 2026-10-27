import type { EmitInput } from '../hub.ts';
import { saveSession } from '../state.ts';
import { SESSION_ID, realOr } from './target.ts';

type IdentityOptions = {
  root: string; resume?: string; fork?: boolean;
  title: () => string | null;
  emit: (ev: Extract<EmitInput, { kind: 'session' }>) => void;
  report: (where: string, e: unknown) => void;
};

/**
 * Who the session is: its id, root and model, the pending fork, and what was saved, heard and announced of them.
 * The invariant it keeps: a fork start branches off `resume`, and until its init names the new id the id is still
 * the SOURCE, which is never written to the registry.
 */
export class SessionIdentity {
  private sid: string | null;
  private dir: string;
  private mdl: string | null = null;
  private forkPending: boolean;
  private cleared = false; // a /clear named no new id: `sid` is the old conversation's until an init names the new one
  private saved: string | null = null; // last id written to the registry
  private heard: string | null; // the id the id listeners last heard of
  private last = ''; // the last `session` event sent, as JSON
  private readonly listeners: ((id: string, prev: string | null) => void)[] = [];
  private readonly o: IdentityOptions;

  constructor(o: IdentityOptions) {
    this.o = o;
    this.dir = o.root;
    this.sid = o.resume ?? null;
    this.heard = o.resume ?? null;
    this.forkPending = !!(o.fork && o.resume);
  }

  get id(): string | null { return this.sid; }
  get root(): string { return this.dir; }
  /** the id this conversation's own records go under; null before the first id, and while a fork's or a cleared
   * conversation's id is not known */
  get ownId(): string | null { return this.forkPending || this.cleared ? null : this.sid; }

  info(): { id: string | null; root: string; model: string | null } {
    return { id: this.sid, root: this.dir, model: this.mdl };
  }

  /** what a new agent starts with */
  startOptions(): { cwd: string; resume?: string; fork?: true } {
    return { cwd: this.dir, ...(this.sid ? { resume: this.sid } : {}), ...(this.forkPending ? { fork: true as const } : {}) };
  }

  /** The CLI's init (it comes at the start of every turn): a new id is adopted and saved once, then announced and heard. */
  init(e: { sessionId?: string; model?: string }): void {
    if (e.sessionId) {
      this.forkPending = this.cleared = false;
      this.sid = e.sessionId;
      // not caught: a registry that cannot be written fails the agent, as before M7-11
      if (this.saved !== e.sessionId) { this.saved = e.sessionId; saveSession(this.dir, e.sessionId); }
    }
    if (e.model) this.mdl = e.model;
    this.announce();
    if (e.sessionId) this.hear(e.sessionId);
  }

  /** /clear: a session id becomes the current one and the resume target (returned; the caller hears it after announcing). */
  reset(newId?: string): string | null {
    this.last = '';
    // the mapper passes any non-empty string; only a session id is adopted
    const next = newId && SESSION_ID.test(newId) ? newId : null;
    this.cleared = !next;
    if (next) {
      this.forkPending = false;
      this.sid = next;
      this.saved = next;
      try { saveSession(this.dir, next); } catch (e) { this.o.report('session', e); }
    }
    return next;
  }

  /** A switch lands on `id` in `real`; true when it is the same session in the same dir (a restart). */
  enter(id: string | null, real: string): boolean {
    const same = id === this.sid && real === realOr(this.dir);
    this.dir = real;
    // a restart before the fork's first init keeps forking; any other target ends the pending fork
    if (!(this.forkPending && id === this.sid)) this.forkPending = false;
    this.sid = id;
    this.cleared = false;
    this.saved = this.forkPending ? null : id;
    this.heard = id; // the server sends this id's comments in onSwitch, not through the id listeners
    this.mdl = null;
    if (id && !this.forkPending) {
      try { saveSession(this.dir, id); } catch (e) { this.o.report('session', e); }
    }
    return same;
  }

  /** Sends `session` when any of its fields changed since the last one. */
  announce(): void {
    const ev = { kind: 'session' as const, id: this.sid, root: this.dir, title: this.o.title(), model: this.mdl };
    const json = JSON.stringify(ev);
    if (json === this.last) return;
    this.last = json;
    this.o.emit(ev);
  }

  /** the feed that held the last announcement is gone: the next one always goes out */
  forget(): void {
    this.last = '';
  }

  /** The id listeners hear a real id once, with the previous one. */
  hear(id: string): void {
    if (id === this.heard) return;
    const prev = this.heard;
    this.heard = id;
    for (const cb of this.listeners) {
      try { cb(id, prev); } catch (e) { this.o.report('session-id', e); }
    }
  }

  onId(cb: (id: string, prev: string | null) => void): void {
    this.listeners.push(cb);
  }
}
