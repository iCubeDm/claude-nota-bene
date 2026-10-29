import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Comment, MediaAnchor, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import type { CameraPose, ModelViewer, ViewerOptions } from '@/model/api.ts';
import { addShape, selectDraft, setMode } from '@/media/markup/slice.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { filesSlice } from '../slice.ts';
import { FileView } from '../FileView.tsx';

const TAB = 'file:m/a.glb';
const POSE_A: CameraPose = { position: [3, 2, 1], target: [0, 0, 0], fov: 50 };
const POSE_B: CameraPose = { position: [-3, 1, 4], target: [0, 0.5, 0], fov: 50 };

// jsdom has no WebGL: a recording fake whose camera the test can move; the 3D module is replaced
let opts: ViewerOptions;
let viewer: ModelViewer & { pose: CameraPose; frozen: boolean[]; playing: boolean[] };
let clips: string[];
const move = (p: CameraPose) => { viewer.pose = p; opts.onView?.(p); };
vi.mock('@/model/viewer.ts', () => ({
  createViewer: (host: HTMLElement, o: ViewerOptions) => {
    opts = o;
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    host.appendChild(canvas); // as the real viewer does: the overlays are children of the canvas's parent
    const v = {
      pose: POSE_A, frozen: [] as boolean[], playing: [] as boolean[], canvas,
      load: vi.fn(async () => { o.onView?.(v.pose); return { meshes: 1, triangles: 12, materials: 1, clips }; }),
      clear: vi.fn(), resetView: vi.fn(), setClip: vi.fn(), setBackground: vi.fn(), setVisible: vi.fn(), snapshot: vi.fn(), dispose: vi.fn(),
      getPose: vi.fn(() => v.pose),
      setPose: vi.fn((p: CameraPose) => { v.pose = p; o.onView?.(p); }),
      setFrozen: vi.fn((f: boolean) => void v.frozen.push(f)),
      setPlaying: vi.fn((p: boolean) => void v.playing.push(p)),
      renderNow: vi.fn(() => v.pose),
    };
    viewer = v as never;
    return v;
  },
}));
const prepare = vi.hoisted(() => vi.fn());
vi.mock('@/media/markup/createMediaComment.ts', async (orig) => ({ ...(await orig<typeof import('@/media/markup/createMediaComment.ts')>()), prepareMediaComment: prepare }));

const IMG = 'a'.repeat(64) + '.jpg';
const modelComment = (id: string, camera: CameraPose | undefined, o: Partial<Comment> = {}, a: Partial<MediaAnchor> = {}): Comment => ({
  id, text: `note ${id}`, status: 'pending', createdAt: 1, images: [IMG], genImages: 1,
  anchor: { kind: 'media', source: { kind: 'file', path: 'm/a.glb' }, width: 800, height: 600, ...(camera && { camera }), shapes: [{ kind: 'rect', color: '#ff3b30', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }], ...a },
  ...o,
});

beforeEach(() => {
  setLang('en');
  clips = [];
  prepare.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-length': '100', etag: '"v1"' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function open(o: { protocol?: number; comments?: Comment[]; jump?: string } = {}) {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(serverEvent({ kind: 'hello', protocol: o.protocol ?? 9 } as ServerEvent));
  if (o.comments) store.dispatch(serverEvent({ kind: 'comments', items: o.comments }));
  if (o.jump) store.dispatch(filesSlice.actions.requestJump({ path: 'm/a.glb', src: 'here', id: o.jump }));
  const r = render(<Provider store={store}><TooltipProvider><FileView path="m/a.glb" active /></TooltipProvider></Provider>);
  await waitFor(() => expect(r.container.querySelector('[data-model-ready]')).toBeTruthy());
  const marks = () => [...r.container.querySelectorAll('[data-mark]')].map((g) => g.getAttribute('data-mark'));
  return { store, r, marks, draft: () => selectDraft(store.getState(), TAB), chips: () => [...r.container.querySelectorAll<HTMLButtonElement>('[data-view-chip]')] };
}

it('an old server (protocol < 9) gets no markup button on a model; 9 does', async () => {
  await open({ protocol: 8 });
  expect(screen.queryByRole('button', { name: /mark up/i })).toBeNull();
  cleanup();
  await open({ protocol: 9 });
  expect(screen.getByRole('button', { name: /mark up/i })).toBeInTheDocument();
});

it('markup freezes the orbit controls and leaving unfreezes; N enters the mode', async () => {
  const { store, draft } = await open();
  expect(viewer.frozen).toEqual([]);
  fireEvent.keyDown(document.body, { code: 'KeyN', key: 'n' });
  expect(draft().on).toBe(true);
  expect(viewer.frozen).toEqual([true]);
  act(() => void store.dispatch(setMode(TAB, false)));
  expect(viewer.frozen).toEqual([true, false]);
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  expect(viewer.frozen).toEqual([true, false, true]);
});

it('entering markup pauses a playing clip and holds the clip controls, reset view and double click', async () => {
  clips = ['spin'];
  const { r, store } = await open();
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(viewer.playing).toEqual([true]);
  act(() => void store.dispatch(setMode(TAB, true)));
  expect(viewer.playing).toEqual([true, false]);
  expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled(); // the clip is paused and stays so
  expect(screen.getByRole('button', { name: 'Reset view' })).toBeDisabled();
  fireEvent.doubleClick(r.container.querySelector('[data-model-host]')!);
  expect(viewer.resetView).not.toHaveBeenCalled();
});

it('Comment → Add stores an anchor with the camera and the canvas size, no time; the frame is drawn from the canvas', async () => {
  prepare.mockImplementation(async (_id: string, _src: unknown, a: MediaAnchor) => ({ images: [IMG], anchor: { version: '"v1"', width: a.width, height: a.height } }));
  const { store } = await open();
  fireEvent.click(screen.getByRole('button', { name: /mark up/i }));
  act(() => void store.dispatch(addShape(TAB, { kind: 'rect', color: '#ff3b30', x: 0.2, y: 0.2, w: 0.3, h: 0.3 })));
  fireEvent.click(screen.getByRole('button', { name: /^Comment/ }));
  fireEvent.change(await screen.findByPlaceholderText('Comment…'), { target: { value: 'wheel is thin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(store.getState().comments.items.length).toBe(1));
  const c = store.getState().comments.items[0]!;
  const a = c.anchor as MediaAnchor;
  expect(a).toMatchObject({ kind: 'media', source: { kind: 'file', path: 'm/a.glb' }, width: 800, height: 600, camera: POSE_A, version: '"v1"' });
  expect('time' in a).toBe(false);
  expect(c).toMatchObject({ text: 'wheel is thin', images: [IMG], genImages: 1 });
  expect(prepare.mock.calls[0]![1]).toBe(viewer.canvas); // the canvas itself is the frame source
  expect(viewer.renderNow).toHaveBeenCalled(); // rendered right before the frame is read
});

it('marks show only while the camera is at the comment\'s pose; elsewhere the chips are the way back', async () => {
  const { marks, chips } = await open({ comments: [modelComment('a', POSE_A), modelComment('b', POSE_B)] });
  expect(marks()).toEqual(['a']);
  act(() => move({ ...POSE_A, position: [3, 2, 1.5] }));
  expect(marks()).toEqual([]);
  expect(chips().map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
  fireEvent.click(chips()[1]!);
  expect(viewer.setPose).toHaveBeenLastCalledWith(POSE_B);
  expect(marks()).toEqual(['b']);
  expect(chips().map((c) => c.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  act(() => move({ ...POSE_B, position: [-3.0000001, 1, 4] })); // a hair away is still the same view
  expect(marks()).toEqual(['b']);
});

it('the chips are gone while marking (the camera is frozen)', async () => {
  const { store, chips } = await open({ comments: [modelComment('a', POSE_A)] });
  expect(chips().length).toBe(1);
  act(() => void store.dispatch(setMode(TAB, true)));
  expect(chips().length).toBe(0);
});

it('comments of an image / without a camera are not chips; a sent one is dimmed and its marks hide once the file changed', async () => {
  const { chips, marks, store } = await open({ comments: [modelComment('a', undefined), modelComment('s', POSE_A, { status: 'sent', sentIn: 'u' }, { version: '"v1"' })] });
  expect(chips().map((c) => c.dataset.viewChip)).toEqual(['s']);
  expect(chips()[0]!.className).toMatch(/opacity-60/);
  expect(marks()).toEqual(['s']);
  act(() => void store.dispatch({ type: 'files/setFileVersion', payload: { path: 'm/a.glb', version: '"v2"' } }));
  expect(marks()).toEqual([]);
  expect(chips()[0]!.title).toMatch(/the file has changed since/);
});

it('jump to source: once the model is ready the camera goes to the comment\'s pose and its marks show', async () => {
  const { marks, store } = await open({ comments: [modelComment('a', POSE_B)], jump: 'a' });
  await waitFor(() => expect(viewer.setPose).toHaveBeenCalledWith(POSE_B));
  expect(marks()).toEqual(['a']);
  expect(store.getState().files.jump).toBeNull();
});

it('jump while marking does not move the camera (the drawing belongs to the view on screen), and is consumed', async () => {
  const { store } = await open({ comments: [modelComment('a', POSE_B)] });
  act(() => void store.dispatch(setMode(TAB, true)));
  act(() => void store.dispatch(filesSlice.actions.requestJump({ path: 'm/a.glb', src: 'here', id: 'a' })));
  await waitFor(() => expect(store.getState().files.jump).toBeNull());
  expect(viewer.setPose).not.toHaveBeenCalled();
});
