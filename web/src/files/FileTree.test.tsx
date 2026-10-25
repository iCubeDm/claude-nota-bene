import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent, TreeEntry } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { revealInTree, setTreeOpen } from '@/tree/slice.ts';
import { selectTabs } from '@/tabs/slice.ts';
import { FileTree } from './FileTree.tsx';

let fs: Record<string, TreeEntry[]>;
let calls: string[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  calls = [];
  fs = {
    '': [{ name: 'src', dir: true }, { name: 'a+b.md', dir: false }, { name: 'zed.txt', dir: false }],
    src: [{ name: 'lib', dir: true }, { name: 'main.ts', dir: false }],
    'src/lib': [{ name: 'deep.ts', dir: false }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const rel = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') ?? '');
    const list = fs[rel];
    return new Response(JSON.stringify(list ?? []), { status: list ? 200 : 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const sdkResult = (historic = false): ServerEvent => ({ kind: 'sdk', ts: 1, m: { type: 'result', subtype: 'success', duration_ms: 1 } } as unknown as ServerEvent);

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(setTreeOpen(true));
  render(<Provider store={store}><FileTree /></Provider>);
  return store;
}
const row = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name.replace(/[+.]/g, '\\$&')}`) });
const live = (store: ReturnType<typeof setup>, ev: ServerEvent) => act(() => { store.dispatch(serverEvent(ev)); });

it('expanding a folder fetches it once; a file click opens a tab', async () => {
  const store = setup();
  fireEvent.click(await row('src'));
  await row('main.ts');
  fireEvent.click(screen.getByRole('button', { name: /^src/ })); // collapse
  fireEvent.click(screen.getByRole('button', { name: /^src/ })); // expand again
  await row('main.ts');
  expect(calls.filter((u) => u.includes('path=src'))).toEqual(['/tree?path=src']);
  fireEvent.click(screen.getByRole('button', { name: /^main\.ts/ }));
  expect(selectTabs(store.getState()).active).toBe('file:src/main.ts');
});

it('builds the url with encodeURIComponent so a + survives', async () => {
  fs['a+b'] = [{ name: 'x.md', dir: false }];
  fs[''] = [{ name: 'a+b', dir: true }];
  setup();
  fireEvent.click(await row('a+b'));
  await row('x.md');
  expect(calls).toContain('/tree?path=a%2Bb');
});

it('refresh keeps open folders, drops vanished ones, and a live result triggers it (a replayed one does not)', async () => {
  const store = setup();
  fireEvent.click(await row('src'));
  await row('main.ts');
  calls.length = 0;
  fs.src = [{ name: 'lib', dir: true }, { name: 'main.ts', dir: false }, { name: 'new.ts', dir: false }];
  // replay with a result inside: no refresh
  live(store, { kind: 'replay', events: [sdkResult(true)] });
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toEqual([]);
  live(store, sdkResult());
  await row('new.ts'); // src is still open and reloaded
  expect(calls).toContain('/tree?path=');
  // folder vanishes on the next refresh: silently dropped
  delete fs.src;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(store.getState().tree.dirs).toEqual([]));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('the filter hides non-matching files but keeps folders', async () => {
  setup();
  await row('zed.txt');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'main' } });
  expect(screen.queryByRole('button', { name: /^zed\.txt/ })).toBeNull();
  expect(screen.getByRole('button', { name: /^src/ })).toBeInTheDocument();
});

it('reveal expands every ancestor and opens the sheet', async () => {
  const store = setup();
  act(() => { store.dispatch(setTreeOpen(false)); store.dispatch(revealInTree('src/lib/deep.ts')); });
  expect(store.getState().tree.open).toBe(true);
  await row('deep.ts');
  expect(store.getState().tree.dirs).toEqual(['src', 'src/lib']);
});

it('a load error shows inline and the rest stays usable; Esc inside closes the sheet', async () => {
  const store = setup();
  fireEvent.click(await row('src'));
  await row('main.ts');
  fs.src = undefined as never;
  (fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Response('x', { status: 500 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Server error · /tree');
  expect(screen.getByRole('button', { name: /^zed\.txt/ })).toBeInTheDocument();
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  screen.getByRole('searchbox').focus();
  act(() => { screen.getByRole('searchbox').dispatchEvent(ev); });
  expect(ev.defaultPrevented).toBe(true);
  expect(store.getState().tree.open).toBe(false);
});

it('shows the pending-comment badge on a file row', async () => {
  const store = setup();
  await row('zed.txt');
  act(() => {
    store.dispatch(serverEvent({ kind: 'comments', items: [
      { id: '1', status: 'pending', text: 't', createdAt: 1, anchor: { source: { kind: 'file', path: 'zed.txt' } } },
    ] } as never));
  });
  expect(screen.getByRole('button', { name: /^zed\.txt/ })).toHaveTextContent('1');
});
