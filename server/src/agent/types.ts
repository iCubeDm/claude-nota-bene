import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageType, Mode, ServerEvent, Stats } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';

export type SendImage = { mediaType: ImageType; data: string /* base64 */; label: string };

export type PermissionAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;

export interface AgentSession {
  readonly messages: AsyncIterable<SDKMessage>; // ends after close()
  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: SendImage[] }): void;
  interrupt(): Promise<void>; // no-op when idle
  /** The CLI's own @ search: project-relative paths, best first. May reject; [] while the CLI is still indexing. */
  fileSuggestions(query: string): Promise<string[]>;
  /** Changes the permission mode of the running CLI; rejects when the CLI refuses. */
  setPermissionMode(mode: Mode): Promise<void>;
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
  start(o: { cwd: string; resume?: string; /** with resume: branch into a new session id (SDK forkSession) */ fork?: boolean; permissionMode: Mode; ask: PermissionAsk }): AgentSession;
  /** `attachments` receives the images found in the transcript; the events carry ImageRefs only. */
  /** Every project's sessions, newest first (sdk: listSessions({ limit: 300 })). */
  listSessions(): Promise<SessionListEntry[]>;
  /** The session's title fields when it belongs to `dir` (or one of its worktrees); null when it does not. */
  sessionInfo(id: string, dir: string): Promise<SessionInfo | null>;
  history(sessionId: string, cwd: string, attachments: AttachmentStore, onError?: (e: unknown) => void): Promise<ServerEvent[]>;
}
