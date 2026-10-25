import fs from 'node:fs';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { transcriptToEvents } from './transcript.ts';

const msgs = JSON.parse(
  fs.readFileSync(new URL('../../test/fixtures/transcript.json', import.meta.url), 'utf8'),
) as SessionMessage[];

describe('transcriptToEvents', () => {
  it('maps assistant messages to sdk events', () => {
    const sdk = transcriptToEvents(msgs).filter((e) => e.kind === 'sdk');
    expect(sdk).toHaveLength(2);
    expect(sdk[0]).toMatchObject({
      kind: 'sdk', ts: 0,
      m: { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: msgs[1]!.message },
    });
  });

  it('skips tool_result-only user turns', () => {
    const events = transcriptToEvents(msgs);
    expect(events.some((e) => e.kind === 'user' && e.id === 'u2')).toBe(false);
  });

  it('user text becomes historic user events in order', () => {
    const events = transcriptToEvents(msgs);
    expect(events.map((e) => (e.kind === 'user' ? e.id : e.kind))).toEqual(['u1', 'sdk', 'sdk', 'u3']);
    expect(events.filter((e) => e.kind === 'user')).toEqual([
      { kind: 'user', id: 'u1', text: 'Read notes.md', historic: true, ts: 0 },
      { kind: 'user', id: 'u3', text: 'Thanks', historic: true, ts: 0 },
    ]);
  });
});
