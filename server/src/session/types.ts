import type { EffortLevel, IdleCompact, ImageRef, Mode, ModelOption, Stats } from '@nota-bene/shared';

export type SessionManager = {
  /** Returns 'switching' for a send refused during a switch (nothing sent or emitted; the server tells the asking socket), else null. */
  send(m: { id: string; text: string; force?: boolean; images?: ImageRef[] }): 'switching' | null;
  interrupt(): void;
  answer(permissionId: string, allow: boolean): void;
  mode(): Mode;
  /** Asks the agent, then persists and announces; a refusal is reported and the current mode re-announced. */
  /** answers with one `mode` event carrying `ack: id` (unless a session switch takes over, which announces its own) */
  setMode(mode: Mode, id?: string): Promise<void>;
  /** the model the agent runs (null until known) and its effort when set */
  model(): { model: string | null; effort?: EffortLevel };
  /** the models the agent offers (empty until it is up) */
  models(): ModelOption[];
  /** Applies from the agent's next response (a running turn goes on), then persists; a refusal is reported. Answers with one `model` event carrying `ack: id`. */
  setModel(next: { model: string; effort?: EffortLevel }, id?: string): Promise<void>;
  info(): { id: string | null; root: string; title: string | null; model: string | null };
  /** The id the conversation's archive goes under (R-M7-1); null before the first id, while a fork's id is pending, and after a /clear that named no id. */
  archiveId(): string | null;
  /** A send not yet answered by a result, a waiting permission, or a switch in progress (R-M4-4). */
  busy(): boolean;
  /** True from the start of a switch's checks to the new session's announcement. */
  switching(): boolean;
  /**
   * Closes the agent, moves to `dir` (absolute, an existing directory; for an id, the session's own cwd) and resumes
   * `id` there, or starts a new session for null. Rejects with a SwitchError while busy or for a bad target, before
   * anything is torn down.
   */
  switch(o: { id: string | null; dir: string }): Promise<void>;
  /**
   * switch({ id: current id, dir: root }): the same session resumed by a fresh agent; a fresh start when there is no
   * id yet. Allowed while busy (the stuck-agent escape hatch): it interrupts first (2 s cap); only a switch blocks it.
   */
  restart(): Promise<void>;
  /**
   * `/compact` or `/clear`: shown in the feed as a user event, then sent to the agent as the plain string. Refused
   * (reported as `busy`) while the agent is busy or the session is switching (R-M4-4).
   */
  command(name: 'compact' | 'clear'): void;
  /** The UI was used (any socket): the idle-compaction clock starts again. */
  activity(): void;
  idleCompact(): IdleCompact;
  /** Persists for this project and announces it to every socket. */
  setIdleCompact(on: boolean): void;
  /** Called at the end of a switch, after the session, mode and stats events (the server sends the comments there). */
  onSwitch(cb: (id: string | null, o: { restart: boolean }) => void): void;
  /** The running agent's @ search; rejects when there is no agent (then the caller falls back). */
  fileSuggestions(query: string): Promise<string[]>;
  /** Context, plan limits and cost as last measured (what a new socket gets). */
  stats(): Stats;
  /** A socket attached: the stats catch up when the skipped 5-minute ticks left them stale. */
  clientAttached(): void;
  /** Stops the stats timers and closes the agent. Idempotent. */
  close(): void;
  /** Called whenever the session id changes to a real id (first init, or a different id after resume/restart). */
  onSessionId(cb: (id: string, prev: string | null) => void): void;
};
