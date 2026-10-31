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

it('preserves each native compaction boundary across turns', async () => {
  const rpc = { async request() { return { data: [1, 2].map((n) => ({ id: `t${n}`, items: [{ type: 'contextCompaction', id: `c${n}` }] })) }; } };
  expect((await loadCodexHistory(rpc, 't', new AttachmentStore({ dir: '/unused' })))).toHaveLength(2);
});

it('reconciles full native history with existing app archives idempotently and keeps current replay bounded', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-native-archive-'));
  const { HistoryArchive } = await import('../../archive.ts');
  const { restoreCodexReplay } = await import('./history.ts');
  const archive = new HistoryArchive({ dir: temp }); const id = '11111111-0000-4000-8000-000000000001';
  const message = (name: string) => ({ kind: 'agent' as const, ts: 0, e: { t: 'message' as const, id: name, text: name } });
  const events = [message('before'), { kind: 'agent' as const, ts: 0, e: { t: 'compacted' as const, boundaryId: 'c1' } }, message('middle'), { kind: 'agent' as const, ts: 0, e: { t: 'compacted' as const, boundaryId: 'c2' } }, message('after')];
  archive.append(id, [{ ...message('before'), ts: 100 }]);
  try {
    expect(restoreCodexReplay(archive, id, events)).toEqual(events.slice(3));
    expect(archive.count(id)).toBe(2);
    restoreCodexReplay(archive, id, events); expect(archive.count(id)).toBe(2);
    const all = [archive.segment(id, 1)!, archive.segment(id, 2)!].flat();
    expect(all.filter((e) => e.kind === 'agent' && e.e.t === 'message' && e.e.id === 'before')).toHaveLength(1);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

it('keeps full native history visible when the app archive cannot be written', async () => {
  const { restoreCodexReplay } = await import('./history.ts');
  const { HistoryArchive } = await import('../../archive.ts');
  const archive = new HistoryArchive({ dir: '/unused' });
  archive.events = () => []; archive.append = () => { throw new Error('disk full'); };
  const events = [{ kind: 'agent' as const, ts: 0, e: { t: 'message' as const, id: 'before', text: 'before' } }, { kind: 'agent' as const, ts: 0, e: { t: 'compacted' as const, boundaryId: 'b' } }];
  const errors: unknown[] = [];
  expect(restoreCodexReplay(archive, 'id', events, (e) => errors.push(e))).toEqual(events);
  expect(errors).toHaveLength(1);
});
