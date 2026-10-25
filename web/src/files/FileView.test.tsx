import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { FileView } from './FileView.tsx';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

type Spec = { status?: number; size?: number; body?: string; head?: Uint8Array };
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
    if (method === 'HEAD') return new Response(null, { status, headers: { 'content-length': String(size) } });
    if (range) return new Response((spec.head ?? new TextEncoder().encode(spec.body ?? '')) as BodyInit, { status: 206 });
    return new Response(spec.body ?? '', { status });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const result = (): ServerEvent => ({ kind: 'sdk', ts: 1, m: { type: 'result', subtype: 'success', duration_ms: 1 } } as unknown as ServerEvent);
function setup(path: string, active = true) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const ui = (a: boolean) => <Provider store={store}><FileView path={path} active={a} /></Provider>;
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
