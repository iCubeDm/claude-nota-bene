import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import type { ModelViewer, ViewerOptions } from '@/model/api.ts';
import { getModelViewer } from '@/model/registry.ts';
import { ModelBody, fetchModel } from './ModelBody.tsx';

// jsdom has no WebGL: the whole 3D module is replaced by a recording fake
const calls: string[] = [];
let opts: ViewerOptions;
let loadImpl: (d: ArrayBuffer) => Promise<{ meshes: number; triangles: number; materials: number; clips: string[]; refused?: number }>;
let loadData: ArrayBuffer[];
let loadArgs: { keepView: boolean; resolve: (u: string) => string | null }[];
const fake = (): ModelViewer => ({
  load: vi.fn(async (d, o) => { calls.push('load'); loadArgs.push(o); loadData.push(d); return loadImpl(d); }),
  clear: vi.fn(() => void calls.push('clear')),
  resetView: vi.fn(() => void calls.push('reset')),
  getPose: vi.fn(() => ({ position: [0, 0, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: poseFov })),
  setPose: vi.fn((p) => void calls.push(`pose:${p.fov}`)),
  setClip: vi.fn((i) => void calls.push(`clip:${i}`)),
  setPlaying: vi.fn((p) => void calls.push(`playing:${p}`)),
  setBackground: vi.fn(),
  setVisible: vi.fn((v) => void calls.push(`visible:${v}`)),
  snapshot: vi.fn(async () => null),
  dispose: vi.fn(() => void calls.push('dispose')),
});
let created: ModelViewer[];
let createThrows: string | null = null;
let poseFov = 77;
vi.mock('@/model/viewer.ts', () => ({
  createViewer: (_h: HTMLElement, o: ViewerOptions) => {
    if (createThrows) throw new Error(createThrows);
    opts = o; const v = fake(); created.push(v); return v;
  },
}));

let fetchGate: Promise<void> | null;
let pulls: number;
let fetchSpec: { etag?: string; status?: number; size?: number; bytes?: number; noLength?: boolean };
let fetched: string[];
beforeEach(() => {
  setLang('en');
  calls.length = 0; created = []; loadArgs = []; loadData = []; fetched = []; fetchGate = null; pulls = 0; poseFov = 77; createThrows = null;
  fetchSpec = { bytes: 2048 };
  loadImpl = async () => ({ meshes: 3, triangles: 12, materials: 2, clips: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    if (fetchGate) await fetchGate;
    const status = fetchSpec.status ?? 200;
    if (status !== 200) return new Response('no', { status });
    const headers: Record<string, string> = {};
    if (fetchSpec.etag) headers.etag = fetchSpec.etag;
    if (!fetchSpec.noLength) headers['content-length'] = String(fetchSpec.size ?? fetchSpec.bytes ?? 0);
    // a stream that counts how often the body is pulled: a body that was not read is 0
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(fetchSpec.bytes ?? 0)); c.close(); } }, { highWaterMark: 0 });
    return new Response(body, { status, headers });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ui = (p: Partial<{ path: string; src: string; active: boolean; reloadKey: number; releaseAfterMs: number }> = {}) => (
  <ModelBody path="models/car/car.glb" src="here" tabId="file:models/car/car.glb" active reloadKey={0} {...p} />
);
const ready = (c: HTMLElement) => c.querySelector('[data-model-ready]');

it('loads: progress, then ready with the info line; the url carries the src', async () => {
  const { container } = render(ui({ src: 'wt-1' }));
  expect(screen.getByText(/Loading/)).toBeTruthy();
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(screen.getByText('2.0 KB · 3 meshes · 12 triangles · 2 materials · 0 animations')).toBeTruthy();
  expect(fetched).toEqual(['/file?path=models%2Fcar%2Fcar.glb&src=wt-1']);
  expect(calls).toEqual(['visible:true', 'clear', 'load']);
  expect(loadArgs[0]!.keepView).toBe(false);
  // a resource named in the file resolves next to it, on the same src
  expect(loadArgs[0]!.resolve('tex/a.png')).toBe('/file?path=models%2Fcar%2Ftex%2Fa.png&src=wt-1');
  expect(loadArgs[0]!.resolve('https://x.y/a.png')).toBeNull();
  expect(getModelViewer('file:models/car/car.glb')).toBe(created[0]);
});

it('a parse error is a visible line, not a blank pane', async () => {
  loadImpl = async () => { throw new Error('bad magic'); };
  const { container } = render(ui());
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('bad magic'));
  expect(ready(container)).toBeNull();
});

it('a failed request and a missing file say so', async () => {
  fetchSpec = { status: 500 };
  const a = render(ui());
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('500'));
  a.unmount();
  fetchSpec = { status: 404 };
  render(ui());
  await waitFor(() => expect(screen.getByText('This file no longer exists')).toBeTruthy());
});

it('a file over 256 MiB is a note with its size and is not loaded', async () => {
  fetchSpec = { size: 300 * 1024 * 1024, bytes: 16 };
  render(ui());
  await waitFor(() => expect(screen.getByText(/too large/).textContent).toContain('300.0 MB'));
  expect(calls).not.toContain('load');
});

it('a tab that was never shown loads nothing; the first activation loads', async () => {
  const { container, rerender } = render(ui({ active: false }));
  await act(async () => {});
  expect(fetched).toEqual([]);
  expect(created).toEqual([]);
  rerender(ui({ active: true }));
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(fetched.length).toBe(1);
});

it('a hidden tab tells the viewer to stop rendering', async () => {
  const { container, rerender } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  rerender(ui({ active: false }));
  await waitFor(() => expect(calls.at(-1)).toBe('visible:false'));
  rerender(ui({ active: true }));
  await waitFor(() => expect(calls.at(-1)).toBe('visible:true'));
  expect(fetched.length).toBe(1); // coming back does not reload
});

it('reload disposes the old model, then loads, keeping the camera', async () => {
  const { container, rerender } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  calls.length = 0;
  rerender(ui({ reloadKey: 1 }));
  await waitFor(() => expect(calls).toEqual(['clear', 'load']));
  expect(fetched.length).toBe(2);
  expect(loadArgs[1]!.keepView).toBe(true);
  expect(created.length).toBe(1);
});

it('a reload of an unchanged file (same ETag) does not parse it again, a changed one does', async () => {
  fetchSpec = { bytes: 64, etag: '"a"' };
  const { container, rerender } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  calls.length = 0;
  rerender(ui({ reloadKey: 1 }));
  await waitFor(() => expect(fetched.length).toBe(2));
  await act(async () => {});
  expect(calls).toEqual([]);
  expect(ready(container)).toBeTruthy();
  fetchSpec = { bytes: 64, etag: '"b"' };
  rerender(ui({ reloadKey: 2 }));
  await waitFor(() => expect(calls).toEqual(['clear', 'load']));
});

it('unmount disposes the viewer and forgets it', async () => {
  const { container, unmount } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  unmount();
  expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
  expect(getModelViewer('file:models/car/car.glb')).toBeUndefined();
});

it('a lost WebGL context shows a message', async () => {
  const { container, rerender } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  fetchSpec = { bytes: 2048, etag: '"same"' };
  act(() => opts.onContextLost());
  expect(screen.getByRole('alert').textContent).toContain('WebGL');
  expect(ready(container)).toBeNull();
  expect(created[0]!.dispose).toHaveBeenCalledTimes(1); // the dead viewer is gone, its canvas with it
  // ↻ makes a new viewer and parses again, whatever the ETag says
  rerender(ui({ reloadKey: 1 }));
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(created.length).toBe(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(getModelViewer('file:models/car/car.glb')).toBe(created[1]);
});

it('a viewer that cannot be made (no WebGL) is a visible line, not "loading" for ever', async () => {
  createThrows = 'Error creating WebGL context.';
  const { container } = render(ui());
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('WebGL'));
  expect(screen.queryByText(/Loading/)).toBeNull();
  expect(ready(container)).toBeNull();
  expect(fetched).toEqual([]);
});

it('a superseded load never replaces the newer one: the info line is the newer file\'s', async () => {
  const waits: ((v: { meshes: number; triangles: number; materials: number; clips: string[] }) => void)[] = [];
  loadImpl = () => new Promise((ok) => void waits.push(ok));
  const { container, rerender } = render(ui());
  await waitFor(() => expect(waits.length).toBe(1));
  rerender(ui({ reloadKey: 1 }));
  await waitFor(() => expect(waits.length).toBe(2));
  await act(async () => waits[1]!({ meshes: 7, triangles: 70, materials: 7, clips: [] }));
  await act(async () => waits[0]!({ meshes: 1, triangles: 10, materials: 1, clips: [] }));
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(screen.getByText(/7 meshes · 70 triangles/)).toBeTruthy();
});

it('switching to another tab mid-download does not restart it', async () => {
  let release!: () => void;
  fetchGate = new Promise((ok) => { release = ok; });
  const { container, rerender } = render(ui());
  await waitFor(() => expect(fetched.length).toBe(1));
  rerender(ui({ active: false }));
  rerender(ui({ active: true }));
  release();
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(fetched.length).toBe(1);
});

it('a reload key that arrives while the tab is hidden waits for the tab to be shown', async () => {
  const { container, rerender } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  rerender(ui({ active: false, reloadKey: 1 }));
  await act(async () => {});
  expect(fetched.length).toBe(1);
  rerender(ui({ active: true, reloadKey: 1 }));
  await waitFor(() => expect(fetched.length).toBe(2));
});

it('an unchanged file (same ETag) is not read at all: the body is cancelled after the headers', async () => {
  fetchSpec = { bytes: 64, etag: '"a"' };
  const { container, rerender } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  const first = pulls;
  rerender(ui({ reloadKey: 1 }));
  await waitFor(() => expect(fetched.length).toBe(2));
  await act(async () => {});
  expect(pulls).toBe(first);
  expect(calls.filter((c) => c === 'load').length).toBe(1);
});

it('a tab hidden for a while gives its WebGL context back, and comes back with the same camera and bytes', async () => {
  {
    fetchSpec = { bytes: 64, etag: '"a"' };
    const { container, rerender } = render(ui({ releaseAfterMs: 30 }));
    await waitFor(() => expect(ready(container)).toBeTruthy());
    rerender(ui({ active: false, releaseAfterMs: 30 }));
    await waitFor(() => expect(created[0]!.dispose).toHaveBeenCalledTimes(1));
    expect(getModelViewer('file:models/car/car.glb')).toBeUndefined();
    rerender(ui({ active: true, releaseAfterMs: 30 }));
    await waitFor(() => expect(created.length).toBe(2));
    await waitFor(() => expect(loadData.length).toBe(2));
    await waitFor(() => expect(calls).toContain('pose:77')); // the camera it had
    expect(loadData.length).toBe(2);
    expect(loadData[1]!.byteLength).toBe(64); // parsed from the kept bytes
    expect(pulls).toBe(1); // not downloaded again
  }
});

it('fetchModel stops reading at the cap even when the server gives no length', async () => {
  const chunk = new Uint8Array(8);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { sent++; c.enqueue(chunk); } }, { highWaterMark: 0 });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
  await expect(fetchModel('/f', new AbortController().signal, null, () => {}, 20)).rejects.toMatchObject({ size: 24 });
  expect(sent).toBe(3);
});

it('the info line says how many external resources were refused', async () => {
  loadImpl = async () => ({ meshes: 1, triangles: 12, materials: 1, clips: [], refused: 2 });
  const { container } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(screen.getByText(/2 external resources not loaded/)).toBeTruthy();
});

it('sizes follow the language', async () => {
  setLang('ru');
  const { container } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(screen.getByText(/^2,0 КБ|^2\.0 КБ/)).toBeTruthy();
});

it('animations: a clip select and a play button; nothing plays by default', async () => {
  loadImpl = async () => ({ meshes: 1, triangles: 12, materials: 1, clips: ['spin', 'bob'] });
  const { container } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(screen.getByText(/2 animations/)).toBeTruthy();
  expect(calls).not.toContain('playing:true');
  const play = screen.getByRole('button', { name: 'Play' });
  act(() => play.click());
  expect(calls.at(-1)).toBe('playing:true');
  expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  const sel = screen.getByRole('combobox') as HTMLSelectElement;
  expect([...sel.options].map((o) => o.text)).toEqual(['spin', 'bob']);
});

it('Reset view and a double click reset the camera', async () => {
  const { container } = render(ui());
  await waitFor(() => expect(ready(container)).toBeTruthy());
  act(() => screen.getByRole('button', { name: 'Reset view' }).click());
  expect(calls.at(-1)).toBe('reset');
  calls.length = 0;
  fireEvent.doubleClick(container.querySelector('[data-model-host]')!);
  expect(calls).toEqual(['reset']);
});

it('a viewer disposed before its parse finished does not overwrite the saved camera with its default', async () => {
  const { container, rerender } = render(ui({ releaseAfterMs: 30 }));
  await waitFor(() => expect(ready(container)).toBeTruthy());
  rerender(ui({ active: false, releaseAfterMs: 30 }));
  await waitFor(() => expect(created[0]!.dispose).toHaveBeenCalledTimes(1)); // saved fov 77
  poseFov = 5; // what a viewer that never showed a model would report
  let finish!: (s: { meshes: number; triangles: number; materials: number; clips: string[] }) => void;
  loadImpl = () => new Promise((ok) => { finish = ok; });
  rerender(ui({ active: true, releaseAfterMs: 30 }));
  await waitFor(() => expect(calls).toContain('load'));
  act(() => opts.onContextLost()); // disposed with its parse pending
  loadImpl = async () => ({ meshes: 1, triangles: 1, materials: 1, clips: [] });
  rerender(ui({ reloadKey: 1, releaseAfterMs: 30 }));
  await waitFor(() => expect(ready(container)).toBeTruthy());
  expect(calls).toContain('pose:77');
  expect(calls).not.toContain('pose:5');
  void finish;
});

it('the hidden-release timer starts again when the download that blocked it finishes while still hidden', async () => {
  let release!: () => void;
  fetchGate = new Promise((ok) => { release = ok; });
  const { container, rerender } = render(ui({ releaseAfterMs: 30 }));
  await waitFor(() => expect(fetched.length).toBe(1));
  rerender(ui({ active: false, releaseAfterMs: 30 }));
  await new Promise((r) => setTimeout(r, 90));
  expect(created[0]!.dispose).not.toHaveBeenCalled(); // blocked by the download
  release();
  await waitFor(() => expect(created[0]!.dispose).toHaveBeenCalledTimes(1));
  expect(container).toBeTruthy();
});
