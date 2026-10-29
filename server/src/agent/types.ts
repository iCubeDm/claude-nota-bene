import type { AgentEvent, Capabilities, EffortLevel, ImageType, Mode, ModelOption, ServerEvent, Stats, SubagentView } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';

export type SendImage = { mediaType: ImageType; data: string /* base64 */; label: string };

export type PermissionAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;

export interface AgentSession {
  /** What the agent says, already mapped (R-M7-13: no SDK shapes past the backend); ends after close(). */
  readonly messages: AsyncIterable<AgentEvent>;
  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: SendImage[] }): void;
  interrupt(): Promise<void>; // no-op when idle
  /** The CLI's own @ search: project-relative paths, best first. May reject; [] while the CLI is still indexing. */
  fileSuggestions(query: string): Promise<string[]>;
  /** Changes the permission mode of the running CLI; rejects when the CLI refuses. */
  setPermissionMode(mode: Mode): Promise<void>;
  /** The models the agent offers; rejects when the CLI cannot answer. */
  supportedModels(): Promise<ModelOption[]>;
  /** From the next response on (a running turn goes on); null: the agent's default. Rejects when the CLI refuses. */
  setModel(model: string | null): Promise<void>;
  /** From the next response on; null: the model's default effort. */
  setEffort(effort: EffortLevel | null): Promise<void>;
  /** Context window usage; rejects when the CLI cannot answer. */
  contextUsage(): Promise<{ used: number; max: number; pct: number }>;
  /** Session cost and plan limits; throws UsageUnavailableError when the SDK has no usage API. */
  usage(): Promise<{ cost: number | null; limits: Stats['limits'] }>;
  close(): void;
}

/** One entry of the CLI's session list (the fields of the SDK's SDKSessionInfo we read). */
export type SessionListEntry = {
  sessionId: string; customTitle?: string; summary?: string; firstPrompt?: string;
  lastModified: number; fileSize?: number; cwd?: string;
};

export type SessionInfo = { customTitle?: string; summary?: string; firstPrompt?: string; cwd?: string };

export interface AgentBackend {
  /** what this agent can do; sent in `hello`, enforced by the server (R-M7-15) */
  readonly capabilities: Capabilities;
  start(o: { cwd: string; resume?: string; /** with resume: branch into a new session id (SDK forkSession) */ fork?: boolean; permissionMode: Mode; /** absent: the agent's default */ model?: string; effort?: EffortLevel; ask: PermissionAsk }): AgentSession;
  /** `attachments` receives the images found in the transcript; the events carry ImageRefs only. */
  /** Every project's sessions, newest first (sdk: listSessions({ limit: 300 })). */
  listSessions(): Promise<SessionListEntry[]>;
  /** The session's title fields when it belongs to `dir` (or one of its worktrees); null when it does not. */
  sessionInfo(id: string, dir: string): Promise<SessionInfo | null>;
  /** The replay of a stored session: `user` events and `agent` events (message, tool-call, tool-update), ts 0. */
  history(sessionId: string, cwd: string, attachments: AttachmentStore, onError?: (e: unknown) => void): Promise<ServerEvent[]>;
  /**
   * The conversation of the subagent the Agent call `toolUseId` started in `sessionId` (read-only; its events are the
   * subagent's own text, tool calls and results). null when no subagent matches. `running`: it has not ended.
   */
  subagent(sessionId: string, cwd: string, toolUseId: string, attachments: AttachmentStore, onError?: (e: unknown) => void): Promise<SubagentView | null>;
}
