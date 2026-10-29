import { act, cleanup, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment, MediaShape } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { getToasts, resetToasts } from '@/shell/toast.ts';
import { drawBadges } from '@/media/markup/badges.ts';
import * as fg from './frameGroups.ts';
import { sendBatch } from './send.ts';

const build = vi.hoisted(() => vi.fn());
vi.mock('./frameGroups.ts', async (orig) => ({ ...(await orig<typeof import('./frameGroups.ts')>()), buildComposites: build }));

const rect: MediaShape = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
const h = (c: string) => c.repeat(64);
const mc = (id: string, o: { path?: string; time?: number; w?: number; img?: string } = {}): Comment => ({
  id, text: `t ${id}`, status: 'pending', createdAt: 1, images: [h(o.img ?? 'a') + '.jpg', h('e') + '.png'],
  anchor: { kind: 'media', source: { kind: 'file', path: o.path ?? 'a.png' }, width: o.w ?? 100, height: 50, ...(o.time !== undefined && { time: o.time }), shapes: [rect] },
});

beforeEach(() => { setLang('en'); localStorage.clear(); localStorage.setItem('panel:comments', '0'); build.mockReset(); resetToasts(); });
afterEach(cleanup);

function setup(items: Comment[]) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items })));
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  return { sent, store };
}
const sentOf = (m: ClientMessage) => m as Extract<ClientMessage, { type: 'send' }>;

it('frameGroups: same path, time and size group (>= 2); other frames and single comments do not', () => {
  const g = fg.frameGroups([mc('c1'), mc('c2'), mc('c3', { path: 'b.png' }), mc('c4', { time: 1 }), mc('c5', { time: 1 }), mc('c6', { w: 200 })]);
  expect(g).toEqual([{ key: 'c1,c2', idx: [0, 1] }, { key: 'c4,c5', idx: [3, 4] }]);
});

it('a send with a shared frame builds one composite, disables a second send, and sends 2 images for 3+1 comments', async () => {
  let done!: (m: Map<string, string>) => void;
  build.mockReturnValue(new Promise((r) => (done = r)));
  const { sent, store } = setup([mc('c1'), mc('c2'), mc('c3'), mc('c4', { path: 'b.png', img: 'b' })]);
  let r1 = '', r2 = '';
  act(() => { r1 = store.dispatch(sendBatch(false)); });
  expect(r1).toBe('building');
  expect(store.getState().composer.uploading).toBe(1);
  act(() => { r2 = store.dispatch(sendBatch(false)); });
  expect(r2).toBe('empty');
  expect(build).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(0);
  const comp = h('c') + '.png';
  await act(async () => done(new Map([['c1,c2,c3', comp]])));
  expect(store.getState().composer.uploading).toBe(0);
  const m = sentOf(sent[0]!);
  expect(m.images?.map((i) => i.id)).toEqual([comp, h('b') + '.jpg']);
  expect(m.images?.map((i) => i.label)).toEqual(['[image 1 · for comments 1, 2, 3]', '[image 2 · for comment 4]']);
  expect(m.text.match(/📎 image 1 \(shared by comments 1, 2, 3; every mark carries a badge with its comment number\)/g)).toHaveLength(3);
  expect(m.text).toContain('📎 images: 2 (frame with marks)');
  expect(m.commentIds).toEqual(['c1', 'c2', 'c3', 'c4']);
});

it('a failed composite toasts, sends nothing and loses nothing', async () => {
  build.mockRejectedValue(new Error('boom'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  await act(async () => void store.dispatch(sendBatch(false)));
  expect(sent).toHaveLength(0);
  expect(store.getState().composer.uploading).toBe(0);
  expect(store.getState().comments.sendingIds).toEqual([]);
  expect(getToasts().map((t) => t.title)).toEqual(['Not sent: could not prepare the combined image']);
  build.mockReset();
  build.mockResolvedValue(new Map());
  await act(async () => void store.dispatch(sendBatch(false)));
  expect(sentOf(sent[0]!).images?.map((i) => i.id)).toEqual([h('a') + '.jpg', h('a') + '.jpg']); // fallback: own frames, never the layer
});

it('a composite for a changed group is ignored: comments fall back to their own frames', async () => {
  build.mockResolvedValue(new Map([['c1,zzz', h('c') + '.png']]));
  const { sent, store } = setup([mc('c1'), mc('c2')]);
  await act(async () => void store.dispatch(sendBatch(false)));
  expect(sentOf(sent[0]!).images).toHaveLength(2);
});

it('a single comment per frame keeps its own frame and builds nothing', () => {
  const { sent, store } = setup([mc('c1'), mc('c2', { path: 'b.png' })]);
  act(() => void store.dispatch(sendBatch(false)));
  expect(build).not.toHaveBeenCalled();
  expect(sentOf(sent[0]!).images).toHaveLength(2);
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
