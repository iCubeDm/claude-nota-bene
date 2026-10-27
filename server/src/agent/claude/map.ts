import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { MODES } from '@nota-bene/shared';
import type { AgentEvent, Mode } from '@nota-bene/shared';

/**
 * The one place that knows the Claude SDK's frame shapes (R-M7-13). Pure: one frame gives zero or more events.
 * It carries the reading that used to sit in the consumers (web feed/tasks/controls, session pump, stats), so
 * the rest of the app sees only AgentEvent. Real shapes: server/test/fixtures/real-frames.json.
 */

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown };
// Loose view of a frame: only the fields read below.
type Frame = {
  type?: string; subtype?: string; uuid?: string; parent_tool_use_id?: string | null;
  event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string; text?: string } };
  message?: { content?: unknown };
  // result
  duration_ms?: number; is_error?: boolean; result?: unknown; errors?: unknown; terminal_reason?: string;
  queued_turn_count?: number; user_message_uuid?: unknown; user_message_uuids?: unknown;
  // command_lifecycle
  command_uuid?: unknown; state?: string;
  // system
  session_id?: unknown; model?: unknown; permissionMode?: unknown;
  status?: string | null; compact_result?: string; compact_error?: string;
  compact_metadata?: { pre_tokens?: number; duration_ms?: number };
  new_conversation_id?: unknown;
  // tasks
  task_id?: string; description?: string; subagent_type?: string; task_type?: string; ambient?: boolean; skip_transcript?: boolean;
  usage?: { total_tokens?: number }; last_tool_name?: string; summary?: string;
  patch?: { status?: string; description?: string };
  // prompt_suggestion, rate_limit_event
  suggestion?: unknown; rate_limit_info?: unknown;
};

const isMode = (v: unknown): v is Mode => (MODES as readonly unknown[]).includes(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** tool_result content: a string, or blocks (text joined, images shown as [image]). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content as Block[]) {
    if (b?.type === 'text') parts.push(b.text ?? '');
    else if (b?.type === 'image') parts.push('[image]');
    else if (b?.type) parts.push(`[${b.type}]`);
  }
  return parts.join('\n');
}

function blocks(m: Frame): Block[] {
  const c = m.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

function turnEnd(m: Frame): AgentEvent {
  // the CLI ends an interrupted turn with subtype success and terminal_reason aborted_streaming | aborted_tools
  const interrupted = !!m.terminal_reason?.startsWith('aborted') || (m.subtype === 'error_during_execution' && !m.is_error);
  const failed = !interrupted && (!!m.is_error || (m.subtype !== undefined && m.subtype !== 'success'));
  // success + is_error carries the text in result; SDKResultError (and the server's crash result) in errors[]
  const text = (typeof m.result === 'string' && m.result)
    || (Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === 'string').join('\n') : '');
  // a result names the sends it answers (user_message_uuids echoes the client ids); naming none, an error answers all
  const named = Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as string[])
    : typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : null;
  return {
    t: 'turn-end',
    stop: interrupted ? 'interrupted' : failed ? 'failed' : 'done',
    secs: Math.round((m.duration_ms ?? 0) / 1000),
    ...(failed && text ? { error: text } : {}),
    answers: named ?? (m.is_error === true ? 'all' : 'none'),
    queued: m.queued_turn_count ?? 0,
  };
}

function system(m: Frame): AgentEvent[] {
  switch (m.subtype) {
    case 'init': {
      const sessionId = str(m.session_id);
      const model = str(m.model);
      return [{ t: 'init', ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}), ...(isMode(m.permissionMode) ? { mode: m.permissionMode } : {}) }];
    }
    case 'status': {
      const out: AgentEvent[] = [];
      if (isMode(m.permissionMode)) out.push({ t: 'mode', mode: m.permissionMode });
      if (m.status === 'compacting') out.push({ t: 'compacting' });
      // a successful compaction ends with the boundary frame, not with this one
      else if (m.status === null && m.compact_result === 'failed') out.push({ t: 'compact-failed', ...(m.compact_error ? { error: m.compact_error } : {}) });
      return out;
    }
    case 'compact_boundary':
      return [{ t: 'compacted', preTokens: m.compact_metadata?.pre_tokens ?? 0, ...(m.compact_metadata?.duration_ms ? { ms: m.compact_metadata.duration_ms } : {}) }];
    case 'conversation_reset':
      return reset(m);
    case 'task_started': case 'task_progress': case 'task_updated': case 'task_notification':
      return task(m);
    default:
      return [];
  }
}

function reset(m: Frame): AgentEvent[] {
  const newId = str(m.new_conversation_id);
  return [{ t: 'reset', ...(newId ? { newId } : {}) }];
}

function task(m: Frame): AgentEvent[] {
  const id = m.task_id;
  if (!id) return [];
  switch (m.subtype) {
    case 'task_started':
      // ambient tasks and the ones kept out of the transcript are not shown
      if (m.ambient || m.skip_transcript) return [];
      return [{ t: 'task', id, phase: 'started', desc: m.description || m.subagent_type || m.task_type || 'task', type: m.task_type ?? '' }];
    case 'task_progress':
      return [{ t: 'task', id, phase: 'progress', tokens: m.usage?.total_tokens || 0, tool: m.last_tool_name || '', summary: m.summary || '' }];
    case 'task_updated': {
      const st = m.patch?.status;
      if (st && st !== 'running' && st !== 'pending' && st !== 'paused') return [{ t: 'task', id, phase: 'done' }];
      return m.patch?.description ? [{ t: 'task', id, phase: 'updated', desc: m.patch.description }] : [];
    }
    default: // task_notification
      return [{ t: 'task', id, phase: 'done' }];
  }
}

export function mapSdk(msg: SDKMessage): AgentEvent[] {
  const m = msg as unknown as Frame;
  const sub = !!m.parent_tool_use_id;
  switch (m.type) {
    case 'system':
      return system(m);
    case 'conversation_reset': // the SDK's reset frame has a top-level type; older ones carry system/subtype
      return reset(m);
    case 'stream_event': {
      if (sub) return []; // a sub-agent's text is not streamed into the chat
      const ev = m.event;
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') return [{ t: 'message-start' }];
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return [{ t: 'message-chunk', text: ev.delta.text ?? '' }];
      return [];
    }
    case 'assistant': {
      const out: AgentEvent[] = [];
      blocks(m).forEach((b, idx) => {
        if (b.type === 'text' && !sub) out.push({ t: 'message', id: `${m.uuid}:${idx}`, text: b.text ?? '' });
        else if (b.type === 'tool_use') out.push({ t: 'tool-call', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {}, sub });
      });
      return out;
    }
    case 'user': // never a bubble (user text arrives as `user` events); only tool results matter
      return blocks(m).filter((b) => b.type === 'tool_result')
        .map((b) => ({ t: 'tool-update', id: b.tool_use_id ?? '', text: resultText(b.content), isError: !!b.is_error }));
    case 'result':
      return [turnEnd(m)];
    case 'command_lifecycle': {
      // a queued send that was cancelled (e.g. Stop with cancel_queued) never gets a result of its own
      const id = str(m.command_uuid);
      return m.state === 'cancelled' && id ? [{ t: 'cancelled', sendId: id }] : [];
    }
    case 'prompt_suggestion':
      return typeof m.suggestion === 'string' ? [{ t: 'suggestion', text: m.suggestion.trim() }] : [];
    case 'rate_limit_event':
      return m.rate_limit_info ? [{ t: 'rate-limit', info: m.rate_limit_info }] : [];
    default:
      return [];
  }
}
