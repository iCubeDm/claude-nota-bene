import { act, cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment, MediaShape } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { addImage, setDraft } from '@/composer/slice.ts';
import { editComment, removeComment } from './slice.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { drawBadges } from '@/media/markup/badges.ts';
import * as fg from './frameGroups.ts';
import { sendBatch } from './send.ts';

const build = vi.hoisted(() => vi.fn());
vi.mock('./frameGroups.ts', async (orig) => ({ ...(await orig<typeof import('./frameGroups.ts')>()), buildComposites: build }));

const rect: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
const h = (c: string) => c.repeat(64);
const PASTED = h('d') + '.png';
/** gen: 2 = an old comment [frame, layer, ...pasted]; 1 = a new one [frame, ...pasted] (`genImages: 1`). */
const mc = (id: string, o: { path?: string; time?: number; w?: number; img?: string; version?: string | null; gen?: 1 | 2; pasted?: string[] } = {}): Comment => {
  const gen = o.gen ?? 2;
  return {
    id, text: `t ${id}`, status: 'pending', createdAt: 1,
    images: [h(o.img ?? 'a') + '.jpg', ...(gen === 2 ? [h('e') + '.png'] : []), ...(o.pasted ?? [])],
    ...(gen === 1 && { genImages: 1 }),
    anchor: { kind: 'media', source: { kind: 'file', path: o.path ?? 'a.png' }, width: o.w ?? 100, height: 50, ...(o.time !== undefined && { time: o.time }), ...(o.version !== null && { version: o.version ?? 'v1' }), shapes: [rect] },
  };
};

beforeEach(() => { setLang('en'); localStorage.clear(); localStorage.setItem('panel:comments', '0'); build.mockReset(); resetToasts(); });
afterEach(cleanup);

function setup(items: Comment[]) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'session', id: 's1', root: '/r', title: null, model: null }));
    store.dispatch(serverEvent({ kind: 'comments', items }));
  });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { sent, store };
}
const sentOf = (m: ClientMessage) => m as Extract<ClientMessage, { type: 'send' }>;
const sends = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'send');
const NOTICE = 'The comments changed during sending: nothing was sent, send again';
/** A build the test finishes by hand. */
function gate() {
  let done!: (m: Map<string, string>) => void;
  build.mockReturnValue(new Promise((r) => (done = r)));
  return (m: Map<string, string>) => act(async () => done(m));
}
const COMP = h('c') + '.png';

it('frameGroups: same path, time, version and size group (>= 2); the key carries the batch positions; no version = no group', () => {
  const g = fg.frameGroups([mc('c1'), mc('c2'), mc('c3', { path: 'b.png' }), mc('c4', { time: 1 }), mc('c5', { time: 1 }), mc('c6', { w: 200 }), mc('c7', { version: null }), mc('c8', { version: null })]);
  expect(g).toEqual([{ key: '1:c1,2:c2', idx: [0, 1] }, { key: '4:c4,5:c5', idx: [3, 4] }]);
});

it('a send with a shared frame builds one composite, disables a second send, and sends 2 images for 3+1 comments', async () => {
  const done = gate();
  const { sent, store } = setup([mc('c1'), mc('c2'), mc('c3'), mc('c4', { path: 'b.png', img: 'b' })]);
  let r1 = '', r2 = '';
  act(() => { r1 = store.dispatch(sendBatch(false)); });
  expect(r1).toBe('building');
  expect(store.getState().composer.building).toBe(true);
  act(() => { r2 = store.dispatch(sendBatch(false)); }); // double click
  expect(r2).toBe('empty');
  expect(build).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(0);
  await done(new Map([['1:c1,2:c2,3:c3', COMP]]));
  expect(store.getState().composer.building).toBe(false);
  expect(sent).toHaveLength(1);
  const m = sentOf(sent[0]!);
  expect(m.images?.map((i) => i.id)).toEqual([COMP, h('b') + '.jpg']);
  expect(m.images?.map((i) => i.label)).toEqual(['[image 1 · for comments 1, 2, 3]', '[image 2 · for comment 4]']);
  expect(m.text.match(/📎 image 1 \(shared by comments 1, 2, 3; every mark carries a badge with its comment number\)/g)).toHaveLength(3);
  expect(m.text).toContain('📎 images: 2 (frame with marks)');
  expect(m.commentIds).toEqual(['c1', 'c2', 'c3', 'c4']);
});

it('a composite that could not be built: each comment of the group goes with its own frame, the send is not blocked', async () => {
  build.mockResolvedValue(new Map());
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  await act(async () => void store.dispatch(sendBatch(false)));
  expect(sentOf(sent[0]!).images?.map((i) => i.id)).toEqual([h('a') + '.jpg', h('a') + '.jpg']); // frames, never the layer
  expect(store.getState().composer.building).toBe(false);
});

it('buildComposites itself never rejects: a failing group is left out', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
  const pending = [mc('c1'), mc('c2')];
  const real = await vi.importActual<typeof import('./frameGroups.ts')>('./frameGroups.ts');
  expect([...(await real.buildComposites(pending, real.frameGroups(pending)))]).toEqual([]);
  vi.unstubAllGlobals();
});

it('a composite for a changed group is ignored: comments fall back to their own frames', async () => {
  build.mockResolvedValue(new Map([['1:c1,2:zzz', COMP]]));
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  await act(async () => void store.dispatch(sendBatch(false)));
  expect(sentOf(sent[0]!).images?.map((i) => i.id)).toEqual([h('a') + '.jpg', h('a') + '.jpg']);
});

it('a single comment per frame keeps its own frame and builds nothing', () => {
  const { sent, store } = setup([mc('c1'), mc('c2', { path: 'b.png' })]);
  act(() => void store.dispatch(sendBatch(false)));
  expect(build).not.toHaveBeenCalled();
  expect(sentOf(sent[0]!).images).toHaveLength(2);
});

it('a comment deleted during the build: nothing is sent, the user is told, the others stay pending and free', async () => {
  const done = gate();
  const { sent, store } = setup([mc('c1'), mc('c2'), mc('c3')]);
  act(() => void store.dispatch(sendBatch(false)));
  expect(store.getState().comments.sendingIds).toEqual(['c1', 'c2', 'c3']);
  act(() => void store.dispatch(removeComment('c1'))); // an earlier one: the badges would be off
  await done(new Map([['1:c1,2:c2,3:c3', COMP]]));
  expect(sends(sent)).toHaveLength(0);
  expect(getToasts().map((x) => x.title)).toEqual([NOTICE]);
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(store.getState().comments.items.map((c) => [c.id, c.status])).toEqual([['c2', 'pending'], ['c3', 'pending']]);
});

it('a comment edited during the build: nothing is sent, the notice shows, the edit is kept', async () => {
  const done = gate();
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  act(() => void store.dispatch(sendBatch(false)));
  act(() => void store.dispatch(editComment('c2', 'new words')));
  await done(new Map([['1:c1,2:c2', COMP]]));
  expect(sends(sent)).toHaveLength(0);
  expect(getToasts().map((x) => x.title)).toEqual([NOTICE]);
  expect(store.getState().comments.items.find((c) => c.id === 'c2')).toMatchObject({ text: 'new words', status: 'pending' });
  expect(store.getState().comments.sendingIds).toEqual([]);
});

it('the session changed during the build: nothing is sent to the new session', async () => {
  const done = gate();
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  act(() => void store.dispatch(sendBatch(false)));
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: 's2', root: '/r', title: null, model: null })));
  await done(new Map([['1:c1,2:c2', COMP]]));
  expect(sent).toHaveLength(0);
  expect(getToasts().map((x) => x.title)).toEqual([NOTICE]);
});

it('text typed and an image pasted during the build stay in the composer; the snapshot is what goes out', async () => {
  const done = gate();
  const A = h('a') + '.png', B = h('b') + '.png';
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  act(() => { store.dispatch(setDraft('go')); store.dispatch(addImage({ id: A, mediaType: 'image/png' })); });
  act(() => void store.dispatch(sendBatch(false)));
  act(() => { store.dispatch(setDraft('go and more')); store.dispatch(addImage({ id: B, mediaType: 'image/png' })); });
  await done(new Map([['1:c1,2:c2', COMP]]));
  const m = sentOf(sent[0]!);
  expect(m.text.startsWith('go\n\nComments on fragments:')).toBe(true);
  expect(m.images?.map((i) => i.id)).toEqual([A, COMP]);
  expect(store.getState().composer.draft).toBe('and more');
  expect(store.getState().composer.images.map((i) => i.id)).toEqual([B]);
});

it('a media comment with a pasted image sends the frame and the pasted image; the old two-generated layout too', async () => {
  const P = PASTED;
  const { sent, store } = setup([mc('n', { gen: 1, pasted: [P] }), mc('o', { path: 'b.png', gen: 2, pasted: [P] })]);
  act(() => void store.dispatch(sendBatch(false)));
  const m = sentOf(sent[0]!);
  expect(m.images?.map((i) => i.id)).toEqual([h('a') + '.jpg', P, h('a') + '.jpg', P]); // never an old layer
  expect(m.text).toContain('📎 images: 1 (frame with marks), 2');
  expect(m.text).toContain('📎 images: 3 (frame with marks), 4');
});

it('grouped media comments: the shared composite, then each comment\'s pasted images (new and old comments)', async () => {
  const P = PASTED;
  build.mockResolvedValue(new Map([['1:n,2:o,3:x', COMP]]));
  const { sent, store } = setup([mc('n', { gen: 1, pasted: [P] }), mc('o', { gen: 2, pasted: [P] }), mc('x', { gen: 1 })]);
  await act(async () => void store.dispatch(sendBatch(false)));
  const m = sentOf(sent[0]!);
  expect(m.images?.map((i) => i.id)).toEqual([COMP, P, P]);
  expect(m.images?.map((i) => i.label)).toEqual(['[image 1 · for comments 1, 2, 3]', '[image 2 · for comment 1]', '[image 3 · for comment 2]']);
  expect(m.text).toContain('1. [a.png · 100×50]');
  expect(m.text).toMatch(/→ t n\n📎 image 1 \(shared by[^\n]*\n📎 images: 2\n/);
  expect(m.text).toMatch(/→ t o\n📎 image 1 \(shared by[^\n]*\n📎 images: 3\n/);
});

it('drawBadges: one disc per comment, inside the picture, not on top of each other, digit drawn', () => {
  const arcs: [number, number][] = [], texts: string[] = [];
  const ctx = new Proxy({}, { get: (_t, p) => (p === 'arc' ? (x: number, y: number) => arcs.push([x, y]) : p === 'fillText' ? (s: string) => texts.push(s) : () => {}), set: () => true }) as never;
  const corner: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0, y: 0, w: 0.1, h: 0.1 };
  drawBadges(ctx, [{ n: 1, shapes: [corner] }, { n: 2, shapes: [corner] }], 1000, 500);
  expect(texts).toEqual(['1', '2']);
  const centres = [arcs[0], arcs[3]];
  expect(centres[0][0]).toBeGreaterThan(0);
  expect(centres[0][1]).toBeGreaterThan(0);
  expect(Math.hypot(centres[0][0] - centres[1][0], centres[0][1] - centres[1][1])).toBeGreaterThan(20);
});

it('the echo of a comment with its anchor keys in another order is not a change: the send goes out', async () => {
  const done = gate();
  const c1 = mc('c1'), c2 = mc('c2');
  const { sent, store } = setup([c1, c2]);
  act(() => void store.dispatch(sendBatch(false)));
  // the server's echo: same comment, the anchor's keys rebuilt in a different order
  const reorder = (c: Comment): Comment => ({ ...c, anchor: Object.fromEntries(Object.entries(c.anchor).reverse()) as Comment['anchor'] });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [reorder(c1), reorder(c2)] })));
  await done(new Map([['1:c1,2:c2', COMP]]));
  expect(sends(sent)).toHaveLength(1);
  expect(getToasts()).toEqual([]);
});

it('a send that throws after the build puts the comments back as pending and says so', async () => {
  const done = gate();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { store } = setup([mc('c1'), mc('c2')]);
  act(() => void store.dispatch(sendBatch(false)));
  const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('boom'); });
  await done(new Map([['1:c1,2:c2', COMP]]));
  spy.mockRestore();
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(store.getState().comments.items.map((c) => c.status)).toEqual(['pending', 'pending']);
  expect(getToasts().map((x) => x.title)).toEqual(['Sending failed; the comments are still here, send again']);
});

it('a build that never finishes: past COMPOSITE_MS the comments go with their own frames', async () => {
  vi.useFakeTimers();
  try {
    build.mockReturnValue(new Promise(() => {}));
    const { sent, store } = setup([mc('c1'), mc('c2')]);
    act(() => void store.dispatch(sendBatch(false)));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(sentOf(sends(sent)[0]!).images?.map((i) => i.id)).toEqual([h('a') + '.jpg', h('a') + '.jpg']);
    expect(store.getState().composer.building).toBe(false);
  } finally { vi.useRealTimers(); }
});
