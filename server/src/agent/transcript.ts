import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '@nota-bene/shared';

type Block = { type?: string; text?: string; content?: unknown };

/** A tool_result whose image blocks are reduced to a bare `{ type: 'image' }`: the feed only shows "[image]". */
export function stripResultImages<B extends Block>(b: B): B {
  if (b.type !== 'tool_result' || !Array.isArray(b.content)) return b;
  return { ...b, content: (b.content as Block[]).map((c) => (c?.type === 'image' ? { type: 'image' } : c)) };
}

/** Live path: drop base64 from tool_result images in user frames before they enter the hub history. */
export function stripUserFrameImages<M>(m: M): M {
  const f = m as { type?: string; message?: { content?: unknown } };
  if (f.type !== 'user' || !Array.isArray(f.message?.content)) return m;
  return { ...f, message: { ...f.message, content: (f.message!.content as Block[]).map(stripResultImages) } } as M;
}

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
      // subagent turns live in separate files (getSubagentMessages), so skipping parent_tool_use_id here is consistent
      const content = (sm.message as { content?: string | Block[] } | undefined)?.content;
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
        // not a bubble: the feed attaches these to their tool lines by tool_use_id
        const results = content.filter((b) => b.type === 'tool_result').map(stripResultImages);
        out.push({
          kind: 'sdk',
          m: { type: 'user', message: { role: 'user', content: results }, parent_tool_use_id: null, uuid: sm.uuid } as never,
          ts: TS,
        });
        continue;
      }
      const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      if (text.trim()) out.push({ kind: 'user', id: sm.uuid, text, historic: true, ts: TS });
    }
  }
  return out;
}
