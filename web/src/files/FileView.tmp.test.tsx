import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { KEY_STORAGE } from '@/net/auth.ts';
import { makeStore } from '@/store/store.ts';
import { closeTab, openFile, restoreTabs, selectTabs, serializeTabs } from '@/tabs/slice.ts';
import { Panes } from '@/tabs/Panes.tsx';
import { FileView } from './FileView.tsx';
import { jumpToFileComment } from './slice.ts';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

// B1e: a temp image tab is a file tab with an absolute path; its bytes come from /tmpimage with the key, as a blob
const KEY = 'k'.repeat(64);
let status: number;
let calls: { url: string; method: string; key: string | null }[];
let made: string[];
let revoked: string[];
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  localStorage.setItem(KEY_STORAGE, KEY);
  status = 200;
  calls = [];
  made = [];
  revoked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', key: new Headers(init?.headers).get('x-nota-bene-key') });
    return status === 200 ? new Response(new Blob(['PNG'], { type: 'image/png' }), { status }) : new Response('nope', { status });
  }));
  URL.createObjectURL = vi.fn(() => { const u = `blob:nb/${made.length}`; made.push(u); return u; });
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const view = (path: string) => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const r = render(<Provider store={store}><TooltipProvider><FileView path={path} active /></TooltipProvider></Provider>);
  return { store, r };
};

it('loads the image through /tmpimage with the key (not /file, no cookie-only route) and shows it from a blob', async () => {
  const { r } = view('/tmp/shot.png');
  await waitFor(() => expect(r.container.querySelector('img')?.getAttribute('src')).toBe('blob:nb/0'));
  expect(calls).toEqual([{ url: '/tmpimage?path=%2Ftmp%2Fshot.png', method: 'GET', key: KEY }]);
  expect(calls.some((c) => c.url.startsWith('/file'))).toBe(false);
  expect(r.container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('blob:nb/0'); // "open raw" never points at a route the cookie cannot open
  expect(r.container.querySelector('[data-pane]')?.getAttribute('data-pane')).toBe('file:/tmp/shot.png');
});

it('a file that is gone shows the short state, in English and in Russian, not an error page', async () => {
  status = 404;
  const { r } = view('/tmp/gone.png');
  await screen.findByText('This file no longer exists');
  expect(r.container.querySelector('img')).toBeNull();
  cleanup();
  setLang('ru');
  view('/tmp/gone.png');
  await screen.findByText('Этого файла больше нет');
});

it('over the cap says so; a failing server is not shown as a picture', async () => {
  status = 413;
  view('/tmp/big.png');
  await screen.findByText('This image is over 50 MB and is not shown');
});

it('reload (the header button) fetches again and revokes the blob it replaces; closing the tab revokes the last', async () => {
  const { r } = view('/tmp/shot.png');
  await waitFor(() => expect(r.container.querySelector('img')?.getAttribute('src')).toBe('blob:nb/0'));
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(r.container.querySelector('img')?.getAttribute('src')).toBe('blob:nb/1'));
  expect(calls.map((c) => c.url)).toEqual(['/tmpimage?path=%2Ftmp%2Fshot.png', '/tmpimage?path=%2Ftmp%2Fshot.png&r=1']);
  expect(revoked).toEqual(['blob:nb/0']);
  r.unmount();
  expect(revoked).toEqual(['blob:nb/0', 'blob:nb/1']);
});

it('closing the tab through the store revokes its blob', async () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(openFile('/tmp/shot.png'));
  const { container } = render(<Provider store={store}><TooltipProvider><Panes chat={null} /></TooltipProvider></Provider>);
  await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:nb/0'));
  act(() => void store.dispatch(closeTab(selectTabs(store.getState()).active)));
  expect(revoked).toEqual(['blob:nb/0']);
});

it('a project image is untouched: /file by the element itself, no fetch, no blob', () => {
  const { r } = view('img/p.png');
  expect(r.container.querySelector('img')?.getAttribute('src')).toBe('/file?path=img%2Fp.png');
  expect(calls).toEqual([]);
  expect(made).toEqual([]);
});

it('comments stay: a comment on a temp image is keyed by its absolute path, so "jump to source" opens the same tab', () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(jumpToFileComment('/tmp/shot.png', 'c1') as never);
  expect(selectTabs(store.getState()).active).toBe('file:/tmp/shot.png');
  expect(selectTabs(store.getState()).open.at(-1)).toMatchObject({ path: '/tmp/shot.png', src: 'here' });
});

it('session restore: a saved tab of a temp image that has vanished reopens into the same short state', async () => {
  status = 404;
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const saved = serializeTabs({ ...selectTabs(store.getState()), open: [{ id: 'chat', kind: 'chat' }, { id: 'file:/tmp/gone.png', kind: 'file', path: '/tmp/gone.png', src: 'here' }], active: 'file:/tmp/gone.png' });
  store.dispatch(restoreTabs(saved));
  render(<Provider store={store}><TooltipProvider><Panes chat={null} /></TooltipProvider></Provider>);
  await screen.findByText('This file no longer exists');
  expect(selectTabs(store.getState()).active).toBe('file:/tmp/gone.png');
});
