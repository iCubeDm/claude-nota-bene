import { act, cleanup, render, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { FileView } from './FileView.tsx';
import { filesSlice } from './slice.ts';
import { setModel3d } from './kinds.ts';

// The factories run only when a module is imported: a count above 0 means the lazy 3D chunk was fetched.
const loaded = vi.hoisted(() => ({ body: 0, viewer: 0 }));
vi.mock('./view/ModelBody.tsx', () => { loaded.body++; return { ModelBody: () => null }; });
vi.mock('@/model/viewer.ts', () => { loaded.viewer++; return { createViewer: () => ({}) }; });

beforeEach(() => { setLang('en'); setModel3d(false); loaded.body = 0; loaded.viewer = 0; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setModel3d(false); });

for (const path of ['m/a.glb', 'm/a.gltf', 'm/a.blend']) {
  it(`experimental 3D off: ${path} is an ordinary file tab, no 3D chunk is loaded`, async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(String(u));
      return new Response(new Uint8Array([0, 1, 2, 0, 255, 0]), { status: 200, headers: { 'content-length': '6' } });
    }));
    const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
    const { container } = render(<Provider store={store}><TooltipProvider><FileView path={path} active /></TooltipProvider></Provider>);
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('[data-model-ready], [data-model-host]')).toBeNull();
    expect(urls.every((u) => u.startsWith('/file?'))).toBe(true); // never /model
    expect(loaded).toEqual({ body: 0, viewer: 0 });
  });
}

it('a restored model tab whose text load won before the hello: the flip to model keeps the pending jump (and drops the stale text)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0, 1, 2]), { status: 200, headers: { 'content-length': '3' } })));
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const { container } = render(<Provider store={store}><TooltipProvider><FileView path="m/a.glb" active /></TooltipProvider></Provider>);
  await waitFor(() => expect(container.querySelector('[data-pane]')?.textContent).not.toBe(''));
  await new Promise((r) => setTimeout(r, 50)); // the text load has landed
  act(() => {
    setModel3d(true); // the hello arrives ...
    store.dispatch(filesSlice.actions.requestJump({ path: 'm/a.glb', src: 'here', id: 'c1' })); // ... with a jump pending
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(store.getState().files.jump).toMatchObject({ id: 'c1' }); // not consumed as a text jump
});
