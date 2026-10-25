import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '@nota-bene/shared';

type Block = { type?: string; text?: string };

// SessionMessage carries no timestamp, so replayed events get a deterministic ts of 0.
const TS = 0;

/** Ports the prototype's "rebuild the feed from the transcript" block (images come in M2). */
export function transcriptToEvents(msgs: SessionMessage[]): ServerEvent[] {
  const out: ServerEvent[] = [];
  for (const sm of msgs) {
    if (sm.type === 'assistant') {
      out.push({
        kind: 'sdk',
        m: { type: 'assistant', message: sm.message, parent_tool_use_id: sm.parent_tool_use_id, uuid: sm.uuid } as never,
        ts: TS,
      });
    } else if (sm.type === 'user' && !sm.parent_tool_use_id) {
      const content = (sm.message as { content?: string | Block[] } | undefined)?.content;
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
      const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      if (text.trim()) out.push({ kind: 'user', id: sm.uuid, text, historic: true, ts: TS });
    }
  }
  return out;
}
