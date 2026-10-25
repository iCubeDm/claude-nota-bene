import fs from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { transcriptToEvents } from './transcript.ts';

const msgs = JSON.parse(
  fs.readFileSync(new URL('../../test/fixtures/transcript.json', import.meta.url), 'utf8'),
) as SessionMessage[];

describe('transcriptToEvents', () => {
  it('maps assistant messages to sdk events', () => {
    const sdk = transcriptToEvents(msgs).filter((e) => e.kind === 'sdk' && e.m.type === 'assistant');
    expect(sdk).toHaveLength(2);
    expect(sdk[0]).toMatchObject({
      kind: 'sdk', ts: 0,
      m: { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: msgs[1]!.message },
    });
  });

  it('tool_result user turns are never bubbles', () => {
    const events = transcriptToEvents(msgs);
    expect(events.some((e) => e.kind === 'user' && e.id === 'u2')).toBe(false);
  });

  it('transcript replay attaches tool results', () => {
    const events = transcriptToEvents(msgs);
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
    const [ev] = transcriptToEvents(m);
    expect(ev).toMatchObject({ m: { message: { content: [{ content: [{ type: 'text', text: 'k' }, { type: 'image' }] }] } } });
    expect(JSON.stringify(ev)).not.toContain('AAAA');
  });

  it('user text becomes historic user events in order', () => {
    const events = transcriptToEvents(msgs);
    expect(events.map((e) => (e.kind === 'user' ? e.id : e.kind))).toEqual(['u1', 'sdk', 'sdk', 'sdk', 'u3']);
    expect(events.filter((e) => e.kind === 'user')).toEqual([
      { kind: 'user', id: 'u1', text: 'Read notes.md', historic: true, ts: 0 },
      { kind: 'user', id: 'u3', text: 'Thanks', historic: true, ts: 0 },
    ]);
  });
});
