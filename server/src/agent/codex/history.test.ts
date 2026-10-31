import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../../attachments.ts';
import { loadCodexHistory } from './history.ts';
import { CodexMapper, itemId } from './map.ts';

describe('Codex history', () => {
  it('paginates oldest-first and preserves native live/replay ids and images', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-codex-history-'));
    try {
      const calls: unknown[] = [];
      const item = { type: 'agentMessage', id: 'answer', text: 'Answer' };
      const api = { async request(_method: string, params: unknown) {
        calls.push(params);
        return calls.length === 1
          ? { data: [{ id: 'turn_1', items: [{ type: 'userMessage', id: 'user_1', clientId: 'send_1', content: [{ type: 'text', text: 'Question' }, { type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] }] }], nextCursor: 'next' }
          : { data: [{ id: 'turn_2', items: [item] }], nextCursor: null };
      } };
      const history = await loadCodexHistory(api, 'thread_1', new AttachmentStore({ dir }));
      expect(calls).toEqual([
        { threadId: 'thread_1', sortDirection: 'asc', itemsView: 'full', limit: 20 },
        { threadId: 'thread_1', sortDirection: 'asc', itemsView: 'full', limit: 20, cursor: 'next' },
      ]);
      expect(history[0]).toMatchObject({ kind: 'user', id: 'send_1', text: 'Question', images: [{ mediaType: 'image/png' }] });
      const live = new CodexMapper().item(item, true).find((e) => e.t === 'message');
      expect(history).toContainEqual({ kind: 'agent', e: live, ts: 0 });
      expect(live).toMatchObject({ id: itemId('answer') });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a repeating cursor rather than looping or silently dropping history', async () => {
    const api = { async request() { return { data: [], nextCursor: 'same' }; } };
    await expect(loadCodexHistory(api, 'thread', new AttachmentStore({ dir: '/unused' }))).rejects.toThrow(/cursor/);
  });
});
