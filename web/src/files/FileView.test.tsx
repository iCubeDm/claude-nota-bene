import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { addShape, selectDraft, setTool } from '@/media/markup/slice.ts';
import { dismissToast, getToasts } from '@/shell/toast.ts';
import { FileView } from './FileView.tsx';
import { jumpToFileComment, selectFileVersion } from './slice.ts';
import { setStartAt } from './startAt.ts';
import { wrapLines } from './wrap.ts';

// like the real one: awaits the version request it was handed and returns it in the anchor patch
const prepareMediaComment = vi.fn(async (_id: string, _el: unknown, _a: unknown, o?: { version?: Promise<string | undefined> }) => {
  const version = await o?.version;
  return { images: ['1'.repeat(64), '2'.repeat(64)], anchor: version === undefined ? {} : { version } };
});
vi.mock('@/media/markup/createMediaComment.ts', () => ({
  prepareMediaComment: (...a: Parameters<typeof prepareMediaComment>) => prepareMediaComment(...a),
  deleteMarks: vi.fn(async () => {}),
}));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

type Spec = { status?: number; size?: number; body?: string; head?: Uint8Array; etag?: string };
let spec: Spec;
let calls: { method: string; url: string; range?: string }[];
beforeEach(() => {
  setLang('en');
  spec = { body: 'hello' };
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push({ method, url, range });
    const status = spec.status ?? 200;
    if (status !== 200) return new Response('nope', { status });
    const size = spec.size ?? new TextEncoder().encode(spec.body ?? '').length;
    if (method === 'HEAD') return new Response(null, { status, headers: { 'content-length': String(size), ...(spec.etag && { etag: spec.etag }) } });
    if (range) return new Response((spec.head ?? new TextEncoder().encode(spec.body ?? '')) as BodyInit, { status: 206 });
    return new Response(spec.body ?? '', { status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const result = (): ServerEvent => ({ kind: 'agent', ts: 1, e: { t: 'turn-end', stop: 'done', secs: 0, answers: 'none', queued: 0 } });
function setup(path: string, active = true) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const ui = (a: boolean) => <Provider store={store}><TooltipProvider><FileView path={path} active={a} /></TooltipProvider></Provider>;
  const r = render(ui(active));
  return { store, r, setActive: (a: boolean) => r.rerender(ui(a)) };
}
const bodyGets = () => calls.filter((c) => c.method === 'GET' && !c.range).length;

it('renders a text file in a data-file-path root, toolbar outside it', async () => {
  spec.body = 'const a = 1;\n';
  const { r } = setup('src/a.ts');
  await waitFor(() => expect(r.container.querySelector('[data-file-path="src/a.ts"]')?.textContent).toContain('const a = 1;'));
  const root = r.container.querySelector('[data-file-path]')!;
  expect(root.getAttribute('data-pane')).toBe('file:src/a.ts');
  const bar = r.container.querySelector('[data-anchor-skip]')!;
  expect(root.contains(bar)).toBe(false);
  expect(bar.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('/file?path=src%2Fa.ts');
  expect(calls.map((c) => c.method + (c.range ? ':range' : ''))).toEqual(['HEAD', 'GET:range', 'GET']);
});

it('long lines wrap by default; the header switch (and Alt+Z) turns it off for every view, remembered', async () => {
  localStorage.removeItem('nb.wrap');
  wrapLines.reload();
  spec.body = 'x'.repeat(500) + '\n';
  const { r } = setup('notes.txt');
  const pre = await waitFor(() => { const p = r.container.querySelector('[data-file-path] pre'); expect(p?.textContent).toContain('xxx'); return p!; });
  expect(pre.className).toContain('whitespace-pre-wrap');
  const sw = screen.getByRole('button', { name: 'Wrap lines' });
  expect(sw.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(sw);
  expect(pre.className).not.toContain('whitespace-pre-wrap');
  expect(pre.className).toContain('overflow-x-auto');
  expect(localStorage.getItem('nb.wrap')).toBe('0');
  wrapLines.reload();
  expect(wrapLines.get()).toBe(false);
  act(() => wrapLines.toggle());
  expect(pre.className).toContain('whitespace-pre-wrap');
});

it('a markdown view has no wrap switch: prose always wraps', async () => {
  spec.body = '# hi\n';
  const { r } = setup('a.md');
  await waitFor(() => expect(r.container.querySelector('.nb-prose')).not.toBeNull());
  expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull();
});

it('a 3 MB file shows the too-large note and fetches no body', async () => {
  spec.size = 3 * 1024 * 1024;
  setup('big.log');
  expect(await screen.findByText(/too large/i)).toBeInTheDocument();
  expect(calls.map((c) => c.method)).toEqual(['HEAD']);
});

it('a NUL in the probe shows the binary note', async () => {
  spec.head = new Uint8Array([65, 0, 66]);
  setup('x.dat');
  expect(await screen.findByText(/binary/i)).toBeInTheDocument();
  expect(bodyGets()).toBe(0);
});

it('404 shows fileGone', async () => {
  spec.status = 404;
  setup('gone.md');
  expect(await screen.findByText(/no longer exists|deleted|gone/i)).toBeInTheDocument();
});

it('other errors show the message', async () => {
  spec.status = 500;
  setup('e.txt');
  expect(await screen.findByText(/500/)).toBeInTheDocument();
});

it('a turnSeq bump refetches the active view; an inactive one waits for activation', async () => {
  const { store, setActive } = setup('a.txt');
  await waitFor(() => expect(bodyGets()).toBe(1));
  spec.body = 'v2';
  act(() => { store.dispatch(serverEvent(result())); });
  await waitFor(() => expect(bodyGets()).toBe(2));
  await screen.findByText('v2');
  setActive(false);
  act(() => { store.dispatch(serverEvent(result())); });
  await new Promise((r) => setTimeout(r, 20));
  expect(bodyGets()).toBe(2);
  setActive(true);
  await waitFor(() => expect(bodyGets()).toBe(3));
});

it('the reload button refetches', async () => {
  setup('a.txt');
  await waitFor(() => expect(bodyGets()).toBe(1));
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(bodyGets()).toBe(2));
});

it('markdown resolves relative images against the file directory', async () => {
  spec.body = '![x](img/a%20b.png)';
  const { r } = setup('docs/n.md');
  await waitFor(() => expect(r.container.querySelector('img')?.getAttribute('src')).toBe('/file?path=docs%2Fimg%2Fa%20b.png'));
  expect(r.container.querySelector('[data-file-path="docs/n.md"]')).not.toBeNull();
});

it('image toggles natural size on click', () => {
  const { r } = setup('p.png');
  const img = r.container.querySelector('img')!;
  expect(img.getAttribute('src')).toBe('/file?path=p.png');
  const before = img.className;
  fireEvent.click(img);
  expect(img.className).not.toBe(before);
  expect(calls).toHaveLength(0);
});

it('every pane has the grid; media is fitted; md and code are cards with the R-M6-2 widths', async () => {
  const img = setup('p.png');
  expect(img.r.container.querySelector('[data-pane="file:p.png"]')?.className).toMatch(/grid-pane.*nb-media-pane/);
  expect(img.r.container.querySelector('img')?.className).toContain('nb-fit');
  fireEvent.click(img.r.container.querySelector('img')!);
  expect(img.r.container.querySelector('[data-pane]')?.className).toContain('nb-natural');
  cleanup();
  const v = setup('v.mp4');
  expect(v.r.container.querySelector('[data-pane]')?.className).toMatch(/grid-pane.*nb-media-pane/);
  expect(v.r.container.querySelector('video')?.className).toContain('nb-fit');
  cleanup();
  const a = setup('s.mp3');
  expect(a.r.container.querySelector('[data-pane]')?.className).toContain('grid-pane');
  expect(a.r.container.querySelector('audio')?.className).toContain('max-w-xl');
  cleanup();
  spec.body = '# hi';
  const md = setup('n.md');
  await waitFor(() => expect(md.r.container.querySelector('[data-file-path] > .nb-card.nb-prose')).not.toBeNull());
  expect(md.r.container.querySelector('[data-pane]')?.className).toContain('grid-pane');
  cleanup();
  spec.body = 'x';
  const code = setup('a.ts');
  await waitFor(() => expect(code.r.container.querySelector('[data-file-path] > pre.nb-card.nb-code')).not.toBeNull());
});

it('video and audio carry data-media-tab', () => {
  const v = setup('v.mp4');
  expect(v.r.container.querySelector('video[controls][data-media-tab="file:v.mp4"]')).not.toBeNull();
  cleanup();
  const a = setup('s.mp3');
  expect(a.r.container.querySelector('audio[controls][data-media-tab="file:s.mp3"]')).not.toBeNull();
});

it('a large text file is not highlighted and says so in the toolbar', async () => {
  spec.body = 'const a = 1;\n'.repeat(20_000); // 260k chars
  const { r } = setup('big.ts');
  await waitFor(() => expect(r.container.querySelector('[data-file-path] code')?.textContent?.length).toBeGreaterThan(200_000));
  expect(r.container.querySelector('.hljs-keyword')).toBeNull();
  expect(screen.getByText('not highlighted: large file')).toBeInTheDocument();
});

it('a small text file is highlighted and has no note', async () => {
  spec.body = 'const a = 1;\n';
  const { r } = setup('s.ts');
  await waitFor(() => expect(r.container.querySelector('.hljs-keyword')).not.toBeNull());
  expect(screen.queryByText('not highlighted: large file')).toBeNull();
});

it('an image that fails to load shows fileGone; reload retries under a new key', () => {
  const { r } = setup('p.png');
  fireEvent.error(r.container.querySelector('img')!);
  expect(screen.getByText('This file no longer exists')).toBeInTheDocument();
  expect(r.container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(r.container.querySelector('img')?.getAttribute('src')).toBe('/file?path=p.png&r=1');
});

it('a failed video retries on a turnSeq bump', () => {
  const { r, store } = setup('v.mp4');
  fireEvent.error(r.container.querySelector('video')!);
  expect(screen.getByText('This file no longer exists')).toBeInTheDocument();
  act(() => { store.dispatch(serverEvent(result())); });
  expect(r.container.querySelector('video')?.getAttribute('src')).toBe('/file?path=v.mp4&r=1');
});

it('↻ on an image, a video or an audio tab reloads it under a new key', () => {
  for (const [path, tag] of [['p.png', 'img'], ['v.mp4', 'video'], ['s.mp3', 'audio']] as const) {
    const { r } = setup(path);
    expect(r.container.querySelector(tag)?.getAttribute('src')).toBe(`/file?path=${path}`);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(r.container.querySelector(tag)?.getAttribute('src')).toBe(`/file?path=${path}&r=1`);
    cleanup();
  }
});

it('after a turn an image always reloads; a video only while paused, and it keeps its position', () => {
  const img = setup('p.png');
  act(() => { img.store.dispatch(serverEvent(result())); });
  expect(img.r.container.querySelector('img')?.getAttribute('src')).toBe('/file?path=p.png&r=1');
  cleanup();

  const { r, store } = setup('v.mp4');
  const v = () => r.container.querySelector('video')!;
  let paused = false;
  Object.defineProperty(v(), 'paused', { get: () => paused });
  act(() => { store.dispatch(serverEvent(result())); });
  expect(v().getAttribute('src')).toBe('/file?path=v.mp4'); // playing: not cut off
  paused = true;
  v().currentTime = 12;
  act(() => { store.dispatch(serverEvent(result())); });
  expect(v().getAttribute('src')).toBe('/file?path=v.mp4&r=1');
  v().currentTime = 0; // a new src starts over
  fireEvent.loadedMetadata(v());
  expect(v().currentTime).toBe(12);
});

const hello = (): ServerEvent => ({ kind: 'hello', protocol: 4 });

it('an image click does not toggle the zoom while marking', () => {
  const { r, store } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = r.container.querySelector('img')!;
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  const before = img.className;
  fireEvent.click(img);
  expect(img.className).toBe(before);
  expect(r.container.querySelector('[data-pane]')?.className).not.toContain('nb-natural');
});

it('a turn ending while marking does not reload the media; leaving catches up', () => {
  const { r, store } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = () => r.container.querySelector('img')!;
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(serverEvent(result())); });
  expect(img().getAttribute('src')).toBe('/file?path=p.png');
  fireEvent.click(screen.getByRole('button', { name: /leave/i })); // no shapes: leaves at once
  expect(img().getAttribute('src')).toBe('/file?path=p.png&r=1');
});

it('the header ↻ while marking does not reload the media (the drawing belongs to this frame); leaving catches up', () => {
  const { r, store } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = () => r.container.querySelector('img')!;
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(img().getAttribute('src')).toBe('/file?path=p.png');
  fireEvent.click(screen.getByRole('button', { name: /leave/i }));
  expect(img().getAttribute('src')).toBe('/file?path=p.png&r=1');
});

it('audio has no markup mode', () => {
  const { r, store } = setup('a.mp3');
  act(() => { store.dispatch(serverEvent(hello())); });
  expect(r.container.querySelector('audio')).not.toBeNull();
  expect(screen.queryByRole('button', { name: /mark up/i })).toBeNull();
});

it('while marking, the video has no controls; leaving restores them', () => {
  const { r, store } = setup('v.mp4');
  act(() => { store.dispatch(serverEvent(hello())); });
  const v = () => r.container.querySelector('video')!;
  expect(v().controls).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  expect(v().controls).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /leave/i }));
  expect(v().controls).toBe(true);
});

const SHAPE = { kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.2, w: 0.3, h: 0.4 } as const;
const UUID = /^[0-9a-f-]{36}$/;

it('Comment on an image opens the popup; Add renders the files and adds the comment, then clears the draft (the mode stays on)', async () => {
  spec = { body: 'x', etag: 'W/"5-1729.5"' };
  prepareMediaComment.mockClear();
  const { r, store } = setup('media/p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = r.container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 1000 });
  Object.defineProperty(img, 'naturalHeight', { value: 500 });
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'HEAD', url: '/file?path=media%2Fp.png' })));
  const tab = 'file:media/p.png';
  act(() => { store.dispatch(addShape(tab, SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(screen.getByText('p.png · 1 shape')).toBeInTheDocument();
  expect(prepareMediaComment).not.toHaveBeenCalled(); // nothing is written until Add
  fireEvent.change(screen.getByPlaceholderText('Comment…'), { target: { value: 'sit here' } });
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Add' })));
  const anchor = { kind: 'media', source: { kind: 'file', path: 'media/p.png' }, width: 1000, height: 500, shapes: [SHAPE] };
  expect(prepareMediaComment).toHaveBeenCalledWith(expect.stringMatching(UUID), img, anchor, { version: expect.any(Promise) });
  const [c] = store.getState().comments.items;
  expect(c).toMatchObject({ id: prepareMediaComment.mock.calls[0]![0], text: 'sit here', anchor: { ...anchor, version: 'W/"5-1729.5"' }, images: ['1'.repeat(64), '2'.repeat(64)] });
  expect(selectDraft(store.getState(), tab)).toMatchObject({ on: true, shapes: [] });
  expect(screen.queryByPlaceholderText('Comment…')).toBeNull();
});

it('a paused video: the anchor has the time to the ms and no version without an ETag; cancelling keeps the draft', async () => {
  prepareMediaComment.mockClear();
  const { r, store } = setup('v.mp4');
  act(() => { store.dispatch(serverEvent(hello())); });
  const v = r.container.querySelector('video')!;
  Object.defineProperty(v, 'videoWidth', { value: 640 });
  Object.defineProperty(v, 'videoHeight', { value: 360 });
  Object.defineProperty(v, 'paused', { value: true });
  v.currentTime = 4.24049;
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(addShape('file:v.mp4', SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(screen.getByText('v.mp4 @ 0:04.240 · 1 shape')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByPlaceholderText('Comment…')).toBeNull();
  expect(selectDraft(store.getState(), 'file:v.mp4')).toMatchObject({ on: true, shapes: [SHAPE] }); // nothing lost
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Add' })));
  expect(prepareMediaComment).toHaveBeenCalledWith(expect.stringMatching(UUID), v,
    { kind: 'media', source: { kind: 'file', path: 'v.mp4' }, width: 640, height: 360, time: 4.24, shapes: [SHAPE] }, expect.anything());
  expect(store.getState().comments.items[0]!.anchor).not.toHaveProperty('version');
});

it('a tab switch while Add saves: the save finishes and the comment is added; the typed text is never lost', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  prepareMediaComment.mockImplementationOnce(async () => { await gate; return { images: ['1'.repeat(64), '2'.repeat(64)], anchor: {} }; });
  const { r, store, setActive } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = r.container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 10 });
  Object.defineProperty(img, 'naturalHeight', { value: 10 });
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(addShape('file:p.png', SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  fireEvent.change(screen.getByPlaceholderText('Comment…'), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  setActive(false); // the user switches tabs while the files upload
  await act(async () => release());
  await waitFor(() => expect(store.getState().comments.items).toHaveLength(1));
  expect(store.getState().comments.items[0]).toMatchObject({ text: 'keep me' });
  expect(selectDraft(store.getState(), 'file:p.png')).toMatchObject({ on: true, shapes: [] });
  expect(screen.queryByPlaceholderText('Comment…')).toBeNull();
  // the save is over: the next popup closes on a tab switch as before
  setActive(true); // still in the mode: the next drawing needs no Mark up
  act(() => { store.dispatch(addShape('file:p.png', SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(screen.getByPlaceholderText('Comment…')).toBeInTheDocument();
  setActive(false);
  expect(screen.queryByPlaceholderText('Comment…')).toBeNull();
});

it('while Add saves the drawing, the markup layer takes no stroke and Comment is off; a shape that slips in is kept', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  prepareMediaComment.mockImplementationOnce(async () => { await gate; return { images: ['1'.repeat(64), '2'.repeat(64)], anchor: {} }; });
  const { r, store } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = r.container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 10 });
  Object.defineProperty(img, 'naturalHeight', { value: 10 });
  Element.prototype.setPointerCapture ??= () => {};
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(addShape('file:p.png', SHAPE)); store.dispatch(setTool('file:p.png', 'pen')); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  // a pen tap is a shape even on a zero-size box: while saving it must not land
  const hit = r.container.querySelector('svg[data-markup-layer] rect')!;
  fireEvent.pointerDown(hit, { button: 0, clientX: 1, clientY: 1, pointerId: 1 });
  fireEvent.pointerUp(hit, { clientX: 1, clientY: 1, pointerId: 1 });
  expect(selectDraft(store.getState(), 'file:p.png').shapes).toEqual([SHAPE]);
  expect(screen.getByRole('button', { name: /^comment/i })).toBeDisabled(); // no second popup over the save
  const OTHER = { ...SHAPE, x: 0.5, w: 0.2 };
  act(() => { store.dispatch(addShape('file:p.png', OTHER)); }); // belt and braces: a shape that got in anyway
  await act(async () => release());
  await waitFor(() => expect(store.getState().comments.items).toHaveLength(1));
  expect(store.getState().comments.items[0]!.anchor).toMatchObject({ shapes: [SHAPE] });
  expect(selectDraft(store.getState(), 'file:p.png')).toMatchObject({ on: true, shapes: [OTHER] }); // not wiped
  expect(screen.getByRole('button', { name: /^comment/i })).toBeEnabled();
});

it('a tab switch while Add saves and the save fails: back on the tab the popup is there with the text and the error', async () => {
  let fail!: () => void;
  const gate = new Promise<void>((_, rej) => (fail = () => rej(new Error('marks 500'))));
  prepareMediaComment.mockImplementationOnce(async () => { await gate; return { images: [], anchor: {} }; });
  const { r, store, setActive } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = r.container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 10 });
  Object.defineProperty(img, 'naturalHeight', { value: 10 });
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(addShape('file:p.png', SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  fireEvent.change(screen.getByPlaceholderText('Comment…'), { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  setActive(false);
  await act(async () => fail());
  expect(store.getState().comments.items).toEqual([]);
  setActive(true);
  expect(screen.getByPlaceholderText('Comment…')).toHaveValue('keep me');
  expect(screen.getByText(/Could not save the drawing.*marks 500/)).toBeInTheDocument();
});

it('Comment pressed before the version request answers: the comment still gets the version', async () => {
  let answer!: () => void;
  const gate = new Promise<void>((r) => (answer = r));
  const real = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'HEAD') { await gate; return new Response(null, { headers: { etag: 'W/"9-9"' } }); }
    return real(url, init);
  }));
  const { r, store } = setup('p.png');
  act(() => { store.dispatch(serverEvent(hello())); });
  const img = r.container.querySelector('img')!;
  Object.defineProperty(img, 'naturalWidth', { value: 10 });
  Object.defineProperty(img, 'naturalHeight', { value: 10 });
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(addShape('file:p.png', SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(store.getState().comments.items).toEqual([]); // waiting for the version
  await act(async () => answer());
  await waitFor(() => expect(store.getState().comments.items).toHaveLength(1));
  expect(store.getState().comments.items[0]!.anchor).toMatchObject({ version: 'W/"9-9"' });
});

it('Comment on media with no natural size (an SVG, or still loading) says why instead of doing nothing', () => {
  for (const t of getToasts()) dismissToast(t.id);
  const { store } = setup('p.svg');
  act(() => { store.dispatch(serverEvent(hello())); });
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => { store.dispatch(addShape('file:p.svg', SHAPE)); });
  fireEvent.click(screen.getByRole('button', { name: /^comment/i }));
  expect(screen.queryByPlaceholderText('Comment…')).toBeNull();
  expect(getToasts().map((t) => t.title)).toContainEqual(expect.stringMatching(/^Cannot mark up this file/));
  expect(selectDraft(store.getState(), 'file:p.svg').shapes).toEqual([SHAPE]); // the drawing stays
});

const mediaOn = (path: string, o: Record<string, unknown> = {}): Comment => ({
  id: 'm1', text: 'here', status: 'pending', createdAt: 1, images: ['1'.repeat(64), '2'.repeat(64)],
  anchor: { kind: 'media', source: { kind: 'file', path }, width: 640, height: 360, shapes: [SHAPE], ...o } as Comment['anchor'],
});

it('jump seeks and pauses the video, once its metadata is loaded', () => {
  const { r, store } = setup('v.mp4');
  act(() => { store.dispatch(serverEvent({ kind: 'comments', items: [mediaOn('v.mp4', { time: 4.24 })] })); });
  const v = r.container.querySelector('video')!;
  let ready = 0;
  Object.defineProperty(v, 'readyState', { get: () => ready });
  const pause = vi.spyOn(v, 'pause').mockImplementation(() => {});
  act(() => { store.dispatch(jumpToFileComment('v.mp4', 'm1')); });
  expect(pause).toHaveBeenCalled();
  expect(store.getState().files.jump).toBeNull(); // consumed
  expect(v.currentTime).toBe(0); // no metadata yet: a seek now would be lost
  ready = 1;
  fireEvent(v, new Event('loadedmetadata'));
  expect(v.currentTime).toBe(4.24);
});

it('jump on a video with metadata seeks at once; on an image it only opens the tab', () => {
  const { r, store } = setup('v.mp4');
  act(() => { store.dispatch(serverEvent({ kind: 'comments', items: [mediaOn('v.mp4', { time: 2.5 })] })); });
  const v = r.container.querySelector('video')!;
  Object.defineProperty(v, 'readyState', { get: () => 4 });
  vi.spyOn(v, 'pause').mockImplementation(() => {});
  act(() => { store.dispatch(jumpToFileComment('v.mp4', 'm1')); });
  expect(v.currentTime).toBe(2.5);
  cleanup();
  const img = setup('p.png');
  act(() => { img.store.dispatch(serverEvent({ kind: 'comments', items: [mediaOn('p.png')] })); });
  act(() => { img.store.dispatch(jumpToFileComment('p.png', 'm1')); });
  expect(img.store.getState().files.jump).toBeNull();
  expect(img.store.getState().tabs.active).toBe('file:p.png');
});

it('a media tab with a versioned comment publishes the file’s current ETag; one without asks for nothing', async () => {
  spec = { body: 'x', etag: 'W/"7-7"' };
  const { store, r } = setup('p.png');
  await new Promise((res) => setTimeout(res, 10));
  expect(calls).toEqual([]);
  act(() => { store.dispatch(serverEvent({ kind: 'comments', items: [mediaOn('p.png', { version: 'W/"1-1"' })] })); });
  await waitFor(() => expect(selectFileVersion(store.getState(), 'p.png')).toBe('W/"7-7"'));
  expect(calls).toEqual([{ method: 'HEAD', url: '/file?path=p.png', range: undefined }]);
  // the media reloads: asked again
  spec.etag = 'W/"8-8"';
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(selectFileVersion(store.getState(), 'p.png')).toBe('W/"8-8"'));
  r.unmount();
  expect(selectFileVersion(store.getState(), 'p.png')).toBeUndefined(); // the tab closed: unknown again
});

it('a start time set by the chat button is applied once the metadata is loaded, and only once', () => {
  setStartAt('file:v.mp4', 7.5);
  const { r } = setup('v.mp4');
  const v = r.container.querySelector('video')!;
  expect(v.currentTime).toBe(0);
  fireEvent(v, new Event('loadedmetadata'));
  expect(v.currentTime).toBe(7.5);
  v.currentTime = 1;
  fireEvent(v, new Event('loadedmetadata'));
  expect(v.currentTime).toBe(1);
});
