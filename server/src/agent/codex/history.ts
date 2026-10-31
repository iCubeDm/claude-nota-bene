import fs from 'node:fs';
import type { HistoryArchive } from '../../archive.ts';
import path from 'node:path';
import type { AgentEvent, ImageRef, ServerEvent } from '@nota-bene/shared';
import { isImageType, MAX_ATTACHMENT_BYTES, type AttachmentStore } from '../../attachments.ts';
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
      mapper.notification('turn/started', { turn });
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
            if (part.type === 'localImage') {
              try {
                const file = string(part.path); if (!path.isAbsolute(file)) throw new Error('Invalid native image path');
                const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
                try {
                  const st = fs.fstatSync(fd); if (!st.isFile() || st.size > MAX_ATTACHMENT_BYTES) throw new Error('Native image is not a bounded regular file');
                  const bytes = Buffer.alloc(st.size); fs.readSync(fd, bytes, 0, bytes.length, 0);
                  const type = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
                    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
                    : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
                    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
                  if (!type) throw new Error('Native attachment is not a supported image');
                  images.push({ id: attachments.put(bytes, type), mediaType: type, label: '[image]' });
                } finally { fs.closeSync(fd); }
              } catch (error) { onError?.(error); }
            }
            if (part.type === 'image') {
              const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(string(part.url));
              if (match && match[2]!.length <= Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 && isImageType(match[1])) {
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

/** Native history retains old turns; the app replay is only the latest segment, with older anchors in /history. */
export function restoreCodexReplay(archive: HistoryArchive, id: string, events: ServerEvent[], onError?: (e: unknown) => void): ServerEvent[] {
  const at = events.findLastIndex((e) => e.kind === 'agent' && e.e.t === 'compacted');
  if (at <= 0) return events;
  try {
    const key = (e: ServerEvent): string => {
      if (e.kind === 'user') return `user:${e.id}`;
      if (e.kind === 'agent') {
        const a = e.e;
        if ('id' in a) return `${a.t}:${a.id}:${'phase' in a ? a.phase : ''}`;
        if (a.t === 'compacted' && a.boundaryId) return `compacted:${a.boundaryId}`;
        return JSON.stringify(a);
      }
      const { ts: _ts, ...rest } = e as ServerEvent & { ts?: number }; return JSON.stringify(rest);
    };
    const stored = archive.events(id), seen = new Set(stored.map(key));
    let unnamed = stored.filter((e) => e.kind === 'agent' && e.e.t === 'compacted' && !e.e.boundaryId).length;
    const missing = events.slice(0, at).filter((e) => {
      if (e.kind === 'agent' && e.e.t === 'compacted' && e.e.boundaryId && unnamed > 0) { unnamed--; seen.add(key(e)); return false; }
      const k = key(e); if (seen.has(k)) return false; seen.add(k); return true;
    });
    // Do not hide older items until their durable archive exists.
    if (missing.length) archive.append(id, missing);
    return events.slice(at);
  } catch (error) { onError?.(error); return events; }
}
