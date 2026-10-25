import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageType, ServerEvent } from '@nota-bene/shared';
import type { AttachmentStore } from '../attachments.ts';

export type SendImage = { mediaType: ImageType; data: string /* base64 */; label: string };

export type PermissionAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;

export interface AgentSession {
  readonly messages: AsyncIterable<SDKMessage>; // ends after close()
  send(m: { uuid: string; text: string; priority: 'next' | 'now'; images?: SendImage[] }): void;
  interrupt(): Promise<void>; // no-op when idle
  close(): void;
}

export interface AgentBackend {
  start(o: { cwd: string; resume?: string; ask: PermissionAsk }): AgentSession;
  /** `attachments` receives the images found in the transcript; the events carry ImageRefs only. */
  history(sessionId: string, cwd: string, attachments: AttachmentStore, onError?: (e: unknown) => void): Promise<ServerEvent[]>;
}
