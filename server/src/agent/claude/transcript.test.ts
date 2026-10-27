import fs from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { AttachmentStore } from '../../attachments.ts';
import { stripUserFrameImages, transcriptToEvents } from './transcript.ts';

const dirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-tr-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const store = (dir = tmpDir()) => new AttachmentStore({ dir });

const msgs = JSON.parse(
  fs.readFileSync(new URL('../../../test/fixtures/transcript.json', import.meta.url), 'utf8'),
) as SessionMessage[];

describe('transcriptToEvents', () => {
  it('maps assistant messages to sdk events', () => {
    const sdk = transcriptToEvents(msgs, store()).filter((e) => e.kind === 'sdk' && e.m.type === 'assistant');
    expect(sdk).toHaveLength(2);
    expect(sdk[0]).toMatchObject({
      kind: 'sdk', ts: 0,
      m: { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: msgs[1]!.message },
    });
  });

  it('tool_result user turns are never bubbles', () => {
    const events = transcriptToEvents(msgs, store());
    expect(events.some((e) => e.kind === 'user' && e.id === 'u2')).toBe(false);
  });

  it('transcript replay attaches tool results', () => {
    const events = transcriptToEvents(msgs, store());
    const sdk = events.filter((e) => e.kind === 'sdk');
    expect(sdk).toHaveLength(3);
    expect(sdk[1]).toMatchObject({
      kind: 'sdk', ts: 0,
      m: { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hello' }] } },
    });
  });

  it('replay strips base64 from tool_result images', () => {
    const big = { type: 'image', source: { type: 'base64', data: 'AAAA' } };
    const m = [{
      type: 'user', uuid: 'ux', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'k' }, big] }] },
    }] as unknown as SessionMessage[];
    const [ev] = transcriptToEvents(m, store());
    expect(ev).toMatchObject({ m: { message: { content: [{ content: [{ type: 'text', text: 'k' }, { type: 'image' }] }] } } });
    expect(JSON.stringify(ev)).not.toContain('AAAA');
  });

  it('user text becomes historic user events in order', () => {
    const events = transcriptToEvents(msgs, store());
    expect(events.map((e) => (e.kind === 'user' ? e.id : e.kind))).toEqual(['u1', 'sdk', 'sdk', 'sdk', 'u3']);
    expect(events.filter((e) => e.kind === 'user')).toEqual([
      { kind: 'user', id: 'u1', text: 'Read notes.md', historic: true, ts: 0 },
      { kind: 'user', id: 'u3', text: 'Thanks', historic: true, ts: 0 },
    ]);
  });

  it('an inline image becomes an ImageRef, stored once, with its label removed from the text', () => {
    const dir = tmpDir();
    const png = Buffer.from('not really a png');
    const m = [{
      type: 'user', uuid: 'ui', parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'look at this' },
        { type: 'text', text: '[Comment 1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
      ] },
    }] as unknown as SessionMessage[];
    const [ev] = transcriptToEvents(m, store(dir));
    expect(ev).toMatchObject({
      kind: 'user', id: 'ui', text: 'look at this', historic: true,
      images: [{ mediaType: 'image/png', label: '[Comment 1]' }, { mediaType: 'image/png', label: '[image]' }],
    });
    const id = (ev as { images: { id: string }[] }).images[0]!.id;
    expect(fs.readdirSync(dir)).toEqual([`${id}.png`]);
    expect(JSON.stringify(ev)).not.toContain(png.toString('base64'));
  });

  it('a plain one-line prompt before an image is not a label', () => {
    const m = [{
      type: 'user', uuid: 'up', parent_tool_use_id: null,
      message: { content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('x').toString('base64') } },
      ] },
    }] as unknown as SessionMessage[];
    expect(transcriptToEvents(m, store())[0]).toMatchObject({ text: 'what is this?', images: [{ label: '[image]' }] });
  });

  it('a failing put keeps every bubble, drops the image and reports once', () => {
    const boom = { put: () => { throw new Error('disk full'); } } as unknown as AttachmentStore;
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const user = (uuid: string, text: string) => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }, img, img] } });
    const errors: unknown[] = [];
    const evs = transcriptToEvents([user('a', 'one'), user('b', 'two')] as unknown as SessionMessage[], boom, (e) => errors.push(e));
    expect(evs.map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['one', 'two']);
    expect(evs.every((e) => e.kind === 'user' && e.images === undefined)).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('stripUserFrameImages', () => {
  it('reduces a bare user image block to {type:image}', () => {
    const f = { type: 'user', message: { content: [{ type: 'text', text: 't' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] } };
    const out = stripUserFrameImages(f);
    expect(out.message.content).toEqual([{ type: 'text', text: 't' }, { type: 'image' }]);
    expect(JSON.stringify(out)).not.toContain('AAAA');
  });
});
