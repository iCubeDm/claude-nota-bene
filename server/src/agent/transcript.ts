import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageRef, ServerEvent } from '@nota-bene/shared';
import { isImageType } from '../attachments.ts';
import type { AttachmentStore } from '../attachments.ts';

type Block = { type?: string; text?: string; content?: unknown; source?: { type?: string; media_type?: string; data?: string } };

/** A tool_result whose image blocks are reduced to a bare `{ type: 'image' }`: the feed only shows "[image]". */
export function stripResultImages<B extends Block>(b: B): B {
  if (b.type !== 'tool_result' || !Array.isArray(b.content)) return b;
  return { ...b, content: (b.content as Block[]).map((c) => (c?.type === 'image' ? { type: 'image' } : c)) };
}

/** Live path: drop base64 from tool_result images in user frames before they enter the hub history. */
export function stripUserFrameImages<M>(m: M): M {
  const f = m as { type?: string; message?: { content?: unknown } };
  if (f.type !== 'user' || !Array.isArray(f.message?.content)) return m;
  // also bare image blocks (an echo of the user's own attachments): they live in the AttachmentStore, not in the history
  const strip = (b: Block): Block => (b?.type === 'image' ? { type: 'image' } : stripResultImages(b));
  return { ...f, message: { ...f.message, content: (f.message!.content as Block[]).map(strip) } } as M;
}

// a label block is one bracketed line, like `[Comment 1]`; any other text before an image is prompt text
const LABEL_RE = /^\[[^\]\n]{1,200}\]$/;

// SessionMessage carries no timestamp, so replayed events get a deterministic ts of 0.
const TS = 0;

/** Ports the prototype's "rebuild the feed from the transcript" block; pasted images go into `attachments`. */
export function transcriptToEvents(msgs: SessionMessage[], attachments: AttachmentStore, onError?: (e: unknown) => void): ServerEvent[] {
  let reported = false;
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
      // pasted images arrive as [label text, image] pairs (see toContent): the label belongs to the image, the rest is the prompt
      const images: ImageRef[] = [];
      const labels = new Set<number>();
      blocks.forEach((b, i) => {
        const src = b.source;
        if (b.type !== 'image' || src?.type !== 'base64' || !isImageType(src.media_type) || typeof src.data !== 'string') return;
        const prev = blocks[i - 1];
        const label = prev?.type === 'text' && LABEL_RE.test(prev.text ?? '') ? prev.text! : '';
        if (label) labels.add(i - 1);
        try {
          images.push({ id: attachments.put(Buffer.from(src.data, 'base64'), src.media_type), mediaType: src.media_type, label: label || '[image]' });
        } catch (e) {
          // keep the bubble, drop only this image; one report per replay
          if (!reported) { reported = true; onError?.(e); }
        }
      });
      const text = blocks.filter((b, i) => b.type === 'text' && !labels.has(i)).map((b) => b.text ?? '').join('\n');
      if (text.trim() || images.length) out.push({ kind: 'user', id: sm.uuid, text, historic: true, ts: TS, ...(images.length ? { images } : {}) });
    }
  }
  return out;
}
