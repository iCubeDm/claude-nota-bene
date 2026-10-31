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

it('replays native local image inputs without following a symlink or importing arbitrary files', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-local-image-'));
  const image = path.join(temp, 'input.png');
  fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  fs.symlinkSync(image, path.join(temp, 'link.png')); fs.writeFileSync(path.join(temp, 'not-image'), 'secret');
  const errors: unknown[] = [];
  const rpc = { async request() { return { data: [{ items: [{ type: 'userMessage', id: 'u', content: [{ type: 'localImage', path: image }, { type: 'localImage', path: path.join(temp, 'link.png') }, { type: 'localImage', path: path.join(temp, 'not-image') }] }] }] }; } };
  try {
    const history = await loadCodexHistory(rpc, 't', new AttachmentStore({ dir: path.join(temp, 'attachments') }), (e) => errors.push(e));
    expect(history[0]).toMatchObject({ kind: 'user', images: [{ mediaType: 'image/png' }] });
    expect(errors).toHaveLength(2);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
