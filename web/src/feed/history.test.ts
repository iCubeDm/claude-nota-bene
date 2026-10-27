import { afterEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { makeStore, serverEvent } from '@/store/store.ts';
import { loadEarlier } from './history.ts';

afterEach(() => vi.unstubAllGlobals());

const session = (id = 's1'): ServerEvent => ({ kind: 'session', id, root: '/p', title: null, model: null });
const marker: ServerEvent = { kind: 'agent', ts: 50, e: { t: 'compacted', preTokens: 1000 } };
const user = (id: string, text = id): ServerEvent => ({ kind: 'user', id, text, ts: 1, historic: true });

function setup(earlier = 2) {
  const store = makeStore({ url: 'ws://x', connect: vi.fn(() => ({ send: () => true, close() {} })) });
  store.dispatch(serverEvent({ kind: 'replay', events: [session(), marker, user('u9', 'after')], earlier }));
  return store;
}
const texts = (store: ReturnType<typeof setup>) => store.getState().feed.items.flatMap((i) => (i.kind === 'user' ? [i.text] : []));
/** `fetch` answering `/history` with `history`; every other route (the sources list a session event asks for) is a 404 */
const stubHistory = (history: (u: string) => Promise<Response> | Response) =>
  vi.stubGlobal('fetch', vi.fn((u: string) => (u.startsWith('/history') ? history(u) : Promise.resolve(new Response('', { status: 404 })))));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('pages one segment per call, newest first, until more is false', async () => {
  const urls: string[] = [];
  const pages: Record<string, unknown> = {
    3: { events: [user('u2', 'second')], segment: 2, more: true },
    2: { events: [user('u1', 'first')], segment: 1, more: false },
  };
  stubHistory((u) => {
    urls.push(u);
    return json(pages[new URL(u, 'http://x').searchParams.get('before')!]);
  });
  const store = setup(2);
  expect(await store.dispatch(loadEarlier())).toBe('ok');
  expect(store.getState().feed.earlier).toBe(1);
  expect(texts(store)).toEqual(['second', 'after']);
  expect(await store.dispatch(loadEarlier())).toBe('ok');
  expect(store.getState().feed.earlier).toBe(0); // fully loaded: the button goes
  expect(texts(store)).toEqual(['first', 'second', 'after']);
  expect(urls).toEqual(['/history?session=s1&before=3', '/history?session=s1&before=2']);
});

it('a 409 (the session changed) is a failure and prepends nothing', async () => {
  stubHistory(() => new Response('not the current session', { status: 409 }));
  const store = setup(1);
  const before = store.getState().feed;
  const measure = vi.fn();
  expect(await store.dispatch(loadEarlier(measure))).toBe('failed');
  expect(store.getState().feed).toBe(before);
  expect(measure).not.toHaveBeenCalled();
});

it('a 404 is the last page: nothing prepended, the button goes', async () => {
  stubHistory(() => new Response('no such segment', { status: 404 }));
  const store = setup(1);
  const items = store.getState().feed.items;
  expect(await store.dispatch(loadEarlier())).toBe('ok');
  expect(store.getState().feed.earlier).toBe(0);
  expect(store.getState().feed.items).toBe(items);
});

it('an answer that arrives after a replay, a /clear or a session change is dropped', async () => {
  const cases: [string, ServerEvent][] = [
    ['replay', { kind: 'replay', events: [session(), marker, user('u9', 'after')], earlier: 2 }],
    ['clear', { kind: 'agent', ts: 60, e: { t: 'reset', newId: 's2' } }],
    ['switch', session('s2')],
  ];
  for (const [what, ev] of cases) {
    let answer!: (r: Response) => void;
    stubHistory(() => new Promise<Response>((r) => { answer = r; }));
    const store = setup(2);
    const measure = vi.fn();
    const done = store.dispatch(loadEarlier(measure));
    store.dispatch(serverEvent(ev));
    const items = store.getState().feed.items;
    answer(json({ events: [user('u2', 'second')], segment: 2, more: true }));
    expect(await done, what).toBe('stale');
    expect(store.getState().feed.items, what).toBe(items);
    expect(measure, what).not.toHaveBeenCalled();
  }
});

it('a segment never reaches another slice: tasks, controls, comments and the live feed stay as they were', async () => {
  const seg: ServerEvent[] = [
    session('other'),
    { kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'rm' }, ts: 3 },
    { kind: 'agent', ts: 4, e: { t: 'task', id: 'k1', phase: 'started', desc: 'explore' } },
    { kind: 'agent', ts: 4, e: { t: 'mode', mode: 'plan' } },
    { kind: 'mode', mode: 'plan' },
    { kind: 'user', id: 'u1', text: 'old send', ts: 4 },
    { kind: 'agent', ts: 5, e: { t: 'turn-end', stop: 'done', secs: 1, answers: 'all', queued: 2 } },
  ];
  stubHistory(() => json({ events: seg, segment: 1, more: false }));
  const store = setup(1);
  const { feed: f0, ...rest0 } = store.getState();
  expect(await store.dispatch(loadEarlier())).toBe('ok');
  const { feed: f1, ...rest1 } = store.getState();
  expect(rest1).toEqual(rest0);
  expect(f1.items.map((i) => i.kind)).toEqual(['permission', 'user', 'done', ...f0.items.map((i) => i.kind)]);
  expect({ ...f1, items: f0.items, earlier: f0.earlier }).toEqual(f0);
});

it('two overlapping loads for the same segment prepend it once: one ok, one stale', async () => {
  const answers: ((r: Response) => void)[] = [];
  stubHistory(() => new Promise<Response>((r) => answers.push(r)));
  const store = setup(2);
  const measure = vi.fn();
  const a = store.dispatch(loadEarlier(measure));
  const b = store.dispatch(loadEarlier(measure));
  expect(answers).toHaveLength(2);
  answers[0]!(json({ events: [user('u2', 'second')], segment: 2, more: true }));
  expect(await a).toBe('ok');
  answers[1]!(json({ events: [user('u2', 'second')], segment: 2, more: true }));
  expect(await b).toBe('stale');
  expect(texts(store)).toEqual(['second', 'after']);
  expect(store.getState().feed.earlier).toBe(1);
  expect(measure).toHaveBeenCalledTimes(1);
});

it('a page the feed would ignore (a segment above `earlier`) is a failure and is not measured: nothing stays armed', async () => {
  stubHistory(() => json({ events: [user('u2', 'second')], segment: 5, more: false }));
  const store = setup(2);
  const before = store.getState().feed;
  const measure = vi.fn();
  expect(await store.dispatch(loadEarlier(measure))).toBe('failed');
  expect(measure).not.toHaveBeenCalled();
  expect(store.getState().feed).toBe(before);
});
