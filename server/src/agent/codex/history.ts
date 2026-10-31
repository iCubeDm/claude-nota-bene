import type { AgentEvent, ImageRef, ServerEvent } from '@nota-bene/shared';
import { isImageType, type AttachmentStore } from '../../attachments.ts';
import { array, CodexMapper, itemId, record, string } from './map.ts';

type HistoryRpc = { request(method: string, params: unknown): Promise<unknown> };

/** Native pages are chronological; all item ids use the same transform as live events. */
export async function loadCodexHistory(rpc: HistoryRpc, threadId: string, attachments: AttachmentStore, onError?: (e: unknown) => void): Promise<ServerEvent[]> {
  const out: ServerEvent[] = [];
  const mapper = new CodexMapper();
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = record(await rpc.request('thread/turns/list', { threadId, sortDirection: 'asc', itemsView: 'full', limit: 20, ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(page.data)) throw new Error('Codex history returned an invalid page');
    for (const rawTurn of page.data) {
      const turn = record(rawTurn);
      // Some runtimes return only summary items unless asked for full; never mistake that for full history.
      if (turn.itemsView === 'notLoaded' || turn.itemsView === 'summary') throw new Error('Codex did not return full history items');
      for (const rawItem of array(turn.items)) {
        const item = record(rawItem);
        if (item.type === 'userMessage') {
          const parts = array(item.content).map(record);
          const images: ImageRef[] = [];
          const texts: string[] = [];
          for (const part of parts) {
            if (part.type === 'text') texts.push(string(part.text));
            if (part.type === 'image') {
              const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(string(part.url));
              if (match && isImageType(match[1])) {
                const label = /^\[[^\]\n]{1,200}\]$/.test(texts.at(-1) ?? '') ? texts.pop()! : '[image]';
                try { images.push({ id: attachments.put(Buffer.from(match[2]!, 'base64'), match[1]), mediaType: match[1], label }); }
                catch (error) { onError?.(error); }
              }
            }
          }
          out.push({ kind: 'user', id: string(item.clientId) || itemId(string(item.id)), text: texts.join('\n'), ts: 0, historic: true, ...(images.length ? { images } : {}) });
        } else {
          for (const event of mapper.item(item, true)) {
            // This mapper produces wire events only; keep the check explicit as the shared union evolves.
            if (!['init', 'rate-limit', 'commands'].includes(event.t)) out.push({ kind: 'agent', e: event as Exclude<AgentEvent, { t: 'init' | 'rate-limit' | 'commands' }>, ts: 0 });
          }
        }
      }
    }
    if (page.nextCursor == null) return out;
    const next = string(page.nextCursor);
    if (!next || seen.has(next)) throw new Error('Codex history returned a repeating/invalid cursor');
    seen.add(next);
    cursor = next;
  }
}
