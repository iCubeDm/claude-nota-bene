import { cleanup, render, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { FileView } from './FileView.tsx';

vi.mock('@/model/viewer.ts', () => ({
  createViewer: () => ({
    load: vi.fn(async () => ({ meshes: 1, triangles: 12, materials: 1, clips: [] })), clear: vi.fn(), resetView: vi.fn(),
    getPose: vi.fn(), setPose: vi.fn(), setClip: vi.fn(), setPlaying: vi.fn(), setBackground: vi.fn(), setVisible: vi.fn(),
    snapshot: vi.fn(), dispose: vi.fn(),
  }),
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('a .glb tab is fetched once as bytes: no HEAD / Range probe / text, no markup, a reload button', async () => {
  setLang('en');
  const calls: { method: string; range?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', range: (init?.headers as Record<string, string> | undefined)?.Range });
    return new Response(new Uint8Array(100), { status: 200, headers: { 'content-length': '100' } });
  }));
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const { container } = render(<Provider store={store}><TooltipProvider><FileView path="m/a.glb" active /></TooltipProvider></Provider>);
  await waitFor(() => expect(container.querySelector('[data-model-ready]')).toBeTruthy());
  expect(calls).toEqual([{ method: 'GET', range: undefined }]);
  expect(container.querySelector('[data-pane="file:m/a.glb"] canvas, [data-model-host]')).toBeTruthy();
  expect(container.querySelector('button[aria-label="Reload"]')).toBeTruthy();
  expect(container.querySelector('svg[data-markup-layer]')).toBeNull();
});
