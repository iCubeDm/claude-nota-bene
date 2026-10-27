import type { AgentBackend } from '../agent/types.ts';
import type { AttachmentStore } from '../attachments.ts';
import type { EventHub } from '../hub.ts';
import type { IdleConfig } from '../idle.ts';

/** createSessionManager's options. */
export type SessionOptions = {
  hub: EventHub; backend: AgentBackend; cwd: string; resume?: string; fork?: boolean; attachments?: AttachmentStore;
  /** how long a switch waits for the old agent's message loop to end (tests shorten it) */
  closeTimeoutMs?: number;
  /** how long a busy restart waits for its interrupt (tests shorten it) */
  interruptTimeoutMs?: number;
  /** how long a switch waits for the transcript read (tests shorten it) */
  historyTimeoutMs?: number;
  /** idle compaction timing (tests shorten it); default from the env, see idle.ts */
  idle?: IdleConfig;
  /** `"idleCompaction": false` in Claude Code's settings (tests stub it) */
  idleOffInSettings?: () => boolean;
};
