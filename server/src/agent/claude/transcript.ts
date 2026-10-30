import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageRef, ServerEvent } from '@nota-bene/shared';
import { isImageType } from '../../attachments.ts';
import { isWire, mapSdk } from './map.ts';
import type { AttachmentStore } from '../../attachments.ts';

type Block = { type?: string; text?: string; content?: unknown; source?: { type?: string; media_type?: string; data?: string } };

// a label block is one bracketed line, like `[Comment 1]`; any other text before an image is prompt text
const LABEL_RE = /^\[[^\]\n]{1,200}\]$/;

// SessionMessage carries no timestamp, so replayed events get a deterministic ts of 0.
const TS = 0;

// how the CLI records a slash command: the command line as tags, its output as another user record
const COMMAND_NAME = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_OUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/;

function agent(out: ServerEvent[], frame: Record<string, unknown>): void {
  for (const e of mapSdk(frame as unknown as SDKMessage).filter(isWire)) out.push({ kind: 'agent', e, ts: TS });
}

/** Ports the prototype's "rebuild the feed from the transcript" block; pasted images go into `attachments`. */
export function transcriptToEvents(msgs: SessionMessage[], attachments: AttachmentStore, onError?: (e: unknown) => void, opts: { subagent?: boolean } = {}): ServerEvent[] {
  // A subagent's own file (getSubagentMessages) tags every message with the parent Agent call's id; that tag is what makes
  // the live mapper treat a frame as a nested one (no text). In its own view the messages are the conversation itself.
  const own = !!opts.subagent;
  let reported = false;
  const out: ServerEvent[] = [];
  for (const sm of msgs) {
    if (sm.type === 'assistant') {
      // through the live mapper, so a replayed message has the id and the shape the live one had
      agent(out, { type: 'assistant', message: sm.message, parent_tool_use_id: own ? null : sm.parent_tool_use_id, uuid: sm.uuid });
    } else if (sm.type === 'user' && (own || !sm.parent_tool_use_id)) {
      // subagent turns live in separate files (getSubagentMessages), so skipping parent_tool_use_id here is consistent
      const content = (sm.message as { content?: string | Block[] } | undefined)?.content;
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
        // not a bubble: tool-update events, which the feed attaches to their tool lines by id (images become [image])
        agent(out, { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: sm.uuid });
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
      let text = blocks.filter((b, i) => b.type === 'text' && !labels.has(i)).map((b) => b.text ?? '').join('\n');
      if (!own && !images.length) {
        const printed = COMMAND_OUT.exec(text);
        if (printed) {
          if (printed[1].trim()) out.push({ kind: 'agent', e: { t: 'message', id: `${sm.uuid}:out`, text: printed[1].trim() }, ts: TS });
          continue;
        }
        const name = COMMAND_NAME.exec(text);
        if (name) {
          const args = COMMAND_ARGS.exec(text)?.[1].trim();
          text = `${name[1].startsWith('/') ? name[1] : `/${name[1]}`}${args ? ` ${args}` : ''}`;
        }
      }
      if (own && !images.length && text.trimStart().startsWith('<system-reminder>')) continue; // the harness's note to the subagent, not part of the talk
      if (text.trim() || images.length) out.push({ kind: 'user', id: sm.uuid, text, historic: true, ts: TS, ...(images.length ? { images } : {}) });
    }
  }
  return out;
}
