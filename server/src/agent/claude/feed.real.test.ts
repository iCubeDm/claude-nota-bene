import fs from 'node:fs';
import { beforeAll, expect, test } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { isWire, mapSdk, type SDKMessage } from './map.ts';

// Golden test over frames shaped like the real CLI (see the fixture's _comment), not like the fake: each frame goes
// through the Claude mapper as the server sends it, then through the web reducer that decides what the user sees.
type Entry = { kind: string; m?: unknown; ts?: number };
type FeedItem = { kind: string; text?: string; final?: boolean; duringWork?: boolean; status?: string; error?: string };
type FeedState = { items: FeedItem[]; busy: boolean; session: unknown };
const entries = (JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/real-frames.json', import.meta.url), 'utf8')) as { events: Entry[] }).events;
/** one fixture entry as the server puts it on the wire: an `sdk` frame becomes its wire AgentEvents */
const wire = (x: Entry): ServerEvent[] => x.kind !== 'sdk' ? [x as ServerEvent]
  : mapSdk(x.m as SDKMessage).filter(isWire).map((e) => ({ kind: 'agent', e, ts: x.ts ?? 0 }));
const isResult = (x: Entry) => x.kind === 'sdk' && (x.m as { type: string }).type === 'result';
const resultAt = entries.flatMap((e, i) => (isResult(e) ? [i] : []));

// the web reducer, loaded by variable path so the server project does not compile web sources (as in session.test.ts)
let reduce!: (s: FeedState, e: ServerEvent) => FeedState;
let emptyFeed!: FeedState;
beforeAll(async () => {
  const href = new URL('../../../../web/src/store/feed.ts', import.meta.url).href;
  ({ reduce, emptyFeed } = (await import(/* @vite-ignore */ href)) as never);
});
/** the feed after the first n fixture entries */
const upTo = (n: number): FeedState => entries.slice(0, n).flatMap(wire).reduce(reduce, emptyFeed);
/** the feed right after the n-th result (0-based) */
const after = (n: number): FeedState => upTo(resultAt[n]! + 1);
const lastDone = (s: FeedState) => s.items.filter((i) => i.kind === 'done').at(-1);

test('the fixture has six turns', () => {
  expect(resultAt).toHaveLength(6);
});

test('busy at key points: queued turn keeps it, everything else clears it', () => {
  expect(after(0).busy).toBe(false); // streamed reply
  expect(after(1).busy).toBe(false); // interrupt
  expect(after(2).busy).toBe(true); // queued_turn_count 1: the mid-turn message still runs
  expect(after(3).busy).toBe(false);
  expect(after(4).busy).toBe(false);
  expect(after(5).busy).toBe(false);
  // between the two queued turns the agent is working: still busy at the second turn's init
  expect(upTo(resultAt[2]! + 2).busy).toBe(true);
});

test('done lines: interrupt is interrupted, errors carry their text', () => {
  expect(lastDone(after(0))).toMatchObject({ status: 'done' });
  expect(lastDone(after(1))).toMatchObject({ status: 'interrupted' });
  expect(lastDone(after(1))).not.toHaveProperty('error');
  expect(lastDone(after(2))).toMatchObject({ status: 'done' });
  expect(lastDone(after(4))).toMatchObject({ status: 'failed', error: 'API Error: 529 Overloaded' });
  expect(lastDone(after(5))).toMatchObject({ status: 'failed', error: 'Tool execution failed\nECONNRESET' });
});

test('final feed', () => {
  const s = upTo(entries.length);
  const view = s.items.map((i) => {
    switch (i.kind) {
      case 'user': return `user ${i.text}${i.duringWork ? ' (during work)' : ''}`;
      case 'assistant': return `assistant${i.final ? '' : ' (open)'} ${i.text}`;
      case 'done': return `done ${i.status}${i.error ? ` ${i.error}` : ''}`;
      default: return i.kind;
    }
  });
  expect(view).toEqual([
    'user say hi',
    'assistant Hi there!',
    'done done',
    'user count slowly to 200',
    'assistant 1, 2, 3, 4, 5,',
    'done interrupted',
    'user write a haiku',
    'assistant Autumn moon', // finalised in place: the stream started before the mid-turn message
    'user and translate it (during work)',
    'done done',
    'assistant Осенняя луна',
    'done done',
    'user again',
    'done failed API Error: 529 Overloaded',
    'user once more',
    'done failed Tool execution failed\nECONNRESET',
  ]);
  expect(s.session).toEqual({ id: '5f0c2a9e-7d41-4c4b-9a53-2f1e8b6d0c77', root: '/Users/dev/proj' });
  expect(s.busy).toBe(false);
});
