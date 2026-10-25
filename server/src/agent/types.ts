import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '@nota-bene/shared';

export type PermissionAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;

export interface AgentSession {
  readonly messages: AsyncIterable<SDKMessage>; // ends after close()
  send(m: { uuid: string; text: string; priority: 'next' | 'now' }): void;
  interrupt(): Promise<void>; // no-op when idle
  close(): void;
}

export interface AgentBackend {
  start(o: { cwd: string; resume?: string; ask: PermissionAsk }): AgentSession;
  history(sessionId: string, cwd: string): Promise<ServerEvent[]>;
}
