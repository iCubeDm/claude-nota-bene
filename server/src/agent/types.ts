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

export interface AgentBackend {
  start(o: { cwd: string; resume?: string; permissionMode: Mode; ask: PermissionAsk }): AgentSession;
  /** `attachments` receives the images found in the transcript; the events carry ImageRefs only. */
  history(sessionId: string, cwd: string, attachments: AttachmentStore, onError?: (e: unknown) => void): Promise<ServerEvent[]>;
}
