import type { Mode } from './protocol.ts';

/**
 * What an agent backend says to the server, whatever agent is behind it (R-M7-13, R-M7-14). Named after ACP's
 * session updates so an ACP adapter is a thin mapping. The Claude mapping lives in server/src/agent/claude/map.ts.
 */
export type StopReason = 'done' | 'interrupted' | 'failed';
export type AgentEvent =
  | { t: 'message-start' }                                   // a streamed text block opens (ACP agent_message_chunk, first)
  | { t: 'message-chunk'; text: string }                     // ACP agent_message_chunk
  | { t: 'message'; id: string; text: string }               // the final text of a block; id `${uuid}:${index}`
  | { t: 'tool-call'; id: string; name: string; input: Record<string, unknown>; sub: boolean } // ACP tool_call
  | { t: 'tool-update'; id: string; text: string; isError: boolean }                          // ACP tool_call_update
  | { t: 'turn-end'; stop: StopReason; secs: number; error?: string; answers: string[] | 'all' | 'none'; queued: number }
  | { t: 'cancelled'; sendId: string }
  | { t: 'compacting' } | { t: 'compact-failed'; error?: string } | { t: 'compacted'; preTokens: number; ms?: number }
  | { t: 'compact-end' }                                     // a compaction ended with no boundary and no failure (hook-blocked, early start, retry)
  | { t: 'reset'; newId?: string }                           // /clear: a new conversation
  | { t: 'init'; sessionId?: string; model?: string; mode?: Mode }    // server-internal: never sent to clients
  | { t: 'mode'; mode: Mode }                                // ACP current_mode_update
  | { t: 'task'; id: string; phase: 'started' | 'progress' | 'updated' | 'done'; desc?: string; type?: string; tokens?: number; tool?: string; summary?: string }
  | { t: 'suggestion'; text: string }
  | { t: 'rate-limit'; info: unknown };                      // server-internal (stats)
