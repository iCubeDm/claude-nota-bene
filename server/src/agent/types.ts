import type { AgentEvent, AgentMode, AgentEffort, Interaction, InteractionAnswer, Capabilities, EffortLevel, ImageType, Mode, ModelOption, ServerEvent, SlashCommand, Stats, SubagentView } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';

export type SendImage = { mediaType: ImageType; data: string /* base64 */; label: string };

export type PermissionAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;

export type InteractAsk = (prompt: Interaction, input: Record<string, unknown>, signal: AbortSignal) => Promise<InteractionAnswer | null>;
export type StartOptions<M = Mode, E = EffortLevel> = { cwd: string; resume?: string; fork?: boolean; permissionMode: M; model?: string; effort?: E; ask: PermissionAsk; interact?: InteractAsk };

export interface AgentSession<M = Mode, E = EffortLevel> {
  /** What the agent says, already mapped (R-M7-13: no SDK shapes past the backend); ends after close(). */
  readonly messages: AsyncIterable<AgentEvent>;
  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: SendImage[] }): void;
  interrupt(): Promise<void>; // no-op when idle
  /** The CLI's own @ search: project-relative paths, best first. May reject; [] while the CLI is still indexing. */
  fileSuggestions(query: string): Promise<string[]>;
  /** Changes the permission mode of the running CLI; rejects when the CLI refuses. */
  setPermissionMode(mode: M): Promise<void>;
  /** The models the agent offers; rejects when the CLI cannot answer. */
  supportedModels(): Promise<ModelOption[]>;
  /** The slash commands and skills of the session as the `/` menu shows them (nothing bound to a terminal; the user's first); rejects when the CLI cannot answer. A later change arrives as a `commands` event. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** From the next response on (a running turn goes on); null: the agent's default. Rejects when the CLI refuses. */
  setModel(model: string | null): Promise<void>;
  /** From the next response on; null: the model's default effort. */
  setEffort(effort: E | null): Promise<void>;
  /** Context window usage; rejects when the CLI cannot answer. */
  contextUsage(): Promise<Stats['context']>;
  /** Session cost and plan limits; throws UsageUnavailableError when the SDK has no usage API. */
  usage(): Promise<{ cost: number | null; limits: Stats['limits']; windows?: Stats['windows'] }>;
  /** Stops a running task (a task_id); the agent then reports it ended as `stopped`. Rejects when the CLI refuses. */
  stopTask(taskId: string): Promise<void>;
  /**
   * Moves the foreground task started by the tool call `toolUseId` to the background (the tool call returns at once and the
   * task goes on). false: no foreground task matched. Rejects when the agent has background tasks disabled.
   */
  backgroundTask(toolUseId: string): Promise<boolean>;
  /** The end of a background shell / Monitor task's output (the CLI keeps the last 8 KiB, escape sequences included). Rejects for any other task. */
  taskOutput(taskId: string): Promise<{ output: string; totalBytes: number; truncated: boolean }>;
  close(): void;
}

/** One entry of the CLI's session list (the fields of the SDK's SDKSessionInfo we read). */
export type SessionListEntry = {
  sessionId: string; customTitle?: string; summary?: string; firstPrompt?: string;
  lastModified: number; fileSize?: number; cwd?: string;
};

export type SessionInfo = { customTitle?: string; summary?: string; firstPrompt?: string; cwd?: string };

export interface AgentBackend<M = Mode, E = EffortLevel> {
  /** what this agent can do; sent in `hello`, enforced by the server (R-M7-15) */
  readonly capabilities: Capabilities;
  /** Native metadata must not fall back to Claude transcript files. */
  nativeSessions?: boolean;
  close?(): Promise<void>;
  account?(): Promise<{ signedIn: boolean; required: boolean }>;
  login?(): Promise<{ url: string }>;

  start(o: StartOptions<M, E>): AgentSession<M, E>;
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
  subagent(sessionId: string, cwd: string, toolUseId: string, attachments: AttachmentStore, onError?: (e: unknown) => void,
    /** what the server knows of the call: a live task of this process, and whether its tool_result is in (see EventHub.callState) */ call?: { live: boolean; hasResult: boolean },
  ): Promise<SubagentView | null>;
}

export type ProviderBackend = AgentBackend<AgentMode, AgentEffort>;
export type ProviderSession = AgentSession<AgentMode, AgentEffort>;
export type ProviderStartOptions = StartOptions<AgentMode, AgentEffort>;
