import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent, TreeEntry } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { revealInTree, setTreeOpen } from '@/tree/slice.ts';
import { openFile, selectTabs } from '@/tabs/slice.ts';
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

const turnEnd = (historic = false): ServerEvent => ({ kind: 'agent', ts: 1, e: { t: 'turn-end', stop: 'done', secs: 0, answers: 'none', queued: 0 } });

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
  expect((await row('src')).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('dir');
  fireEvent.click(await row('src'));
  // file-type icons (M6-11): an open folder, a TypeScript file
  expect((await row('main.ts')).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('ts');
  expect(screen.getByRole('button', { name: /^src/ }).querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('dirOpen');
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
  live(store, { kind: 'replay', events: [turnEnd(true)] });
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toEqual([]);
  live(store, turnEnd());
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
      { id: '2', status: 'sent', text: 't', createdAt: 1, anchor: { source: { kind: 'file', path: 'zed.txt' } } },
      { id: '3', status: 'pending', text: 't', createdAt: 1, anchor: { source: { kind: 'file', path: 'a+b.md' } } },
      { id: '4', status: 'pending', text: 't', createdAt: 1, anchor: { source: { kind: 'message', id: 'zed.txt' } } },
    ] } as never));
  });
  expect(screen.getByRole('button', { name: /^zed\.txt/ }).querySelector('[data-badge]')).toHaveTextContent(/^1$/);
});

it('Esc with focus inside hands focus to the header toggle, so it is not left in a hidden sheet', async () => {
  const toggle = document.createElement('button');
  toggle.id = 'toggleTree';
  document.body.append(toggle);
  try {
    setup();
    const r = await row('zed.txt');
    r.focus();
    act(() => { fireEvent.keyDown(r, { key: 'Escape' }); });
    expect(document.activeElement).toBe(toggle);
  } finally {
    toggle.remove();
  }
});

it('a refresh that resolves after a switch to another root does not prune that root\'s folders (M4-10)', async () => {
  const store = setup();
  live(store, { kind: 'session', id: null, root: '/r1', title: null, model: null });
  fireEvent.click(await row('src'));
  await row('main.ts');
  localStorage.setItem('tree:/r2', JSON.stringify(['docs']));
  // the next listing is held until after the switch; it says src is gone
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  delete fs.src;
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { await held; return real(url); }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  live(store, { kind: 'replay', events: [] });
  live(store, { kind: 'session', id: null, root: '/r2', title: null, model: null });
  expect(store.getState().tree.dirs).toEqual(['docs']);
  await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
  expect(store.getState().tree.dirs).toEqual(['docs']);
  expect(localStorage.getItem('tree:/r2')).toBe(JSON.stringify(['docs']));
  expect(JSON.parse(localStorage.getItem('tree:/r1')!)).toEqual(['src']);
});

it('Select opened file reveals the active file tab; it is off while the chat is active (M6-10)', async () => {
  const store = setup();
  const btn = await screen.findByRole('button', { name: 'Select opened file' });
  expect(btn).toBeDisabled();
  act(() => { store.dispatch(openFile({ path: 'src/lib/deep.ts', src: 'here' })); });
  fireEvent.click(btn);
  await row('deep.ts');
  expect(store.getState().tree.dirs).toEqual(expect.arrayContaining(['src', 'src/lib']));
});

it('Expand all opens every folder level by level, skipping node_modules and .git; Collapse all closes them (M6-10)', async () => {
  fs[''] = [{ name: '.git', dir: true }, { name: 'node_modules', dir: true }, { name: 'src', dir: true }, { name: 'docs', dir: true }];
  fs.docs = [{ name: 'a.md', dir: false }];
  const store = setup();
  await row('src');
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  await row('deep.ts');
  await row('a.md');
  expect([...store.getState().tree.dirs].sort()).toEqual(['docs', 'src', 'src/lib']);
  expect(calls.some((u) => u.includes('node_modules') || u.includes('.git'))).toBe(false);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Expand all' })).not.toHaveAttribute('aria-disabled', 'true'));
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  expect(store.getState().tree.dirs).toEqual([]);
  expect(screen.queryByRole('button', { name: /^deep\.ts/ })).toBeNull();
});

it('Expand all stops at the row cap (M6-10)', { timeout: 40000 }, async () => {
  // 30 folders of 100 files each: the first level shows 30 rows, the second 3030, over the cap; no third round
  fs[''] = Array.from({ length: 30 }, (_, i) => ({ name: `d${String(i).padStart(2, '0')}`, dir: true }));
  for (let i = 0; i < 30; i++) {
    const n = `d${String(i).padStart(2, '0')}`;
    fs[n] = [{ name: 'sub', dir: true }, ...Array.from({ length: 100 }, (_, j) => ({ name: `f${j}.ts`, dir: false }))];
    fs[`${n}/sub`] = [{ name: 'x.ts', dir: false }];
  }
  const store = setup();
  await row('d00');
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  // ~2000 rows render slowly in jsdom under a full parallel run or a small CI runner: a much wider wait than the default 1 s
  await waitFor(() => expect(screen.getByRole('button', { name: 'Expand all' })).not.toHaveAttribute('aria-disabled', 'true'), { timeout: 30000 });
  // 30 + 19 × 101 = 1949 rows; the 20th folder would make 2050: the run ends there, in order
  expect(store.getState().tree.dirs).toEqual(Array.from({ length: 19 }, (_, i) => `d${String(i).padStart(2, '0')}`));
  expect(document.querySelectorAll('#tree-sheet [data-path]').length).toBeLessThanOrEqual(2000);
  expect(calls.some((u) => u.includes('sub'))).toBe(false);
});

it('Expand all works after an earlier load error, and a turn ending during the run refreshes after it (M6-10 review)', async () => {
  const store = setup();
  await row('src');
  // an earlier, unrelated error
  const real = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementationOnce(async () => new Response('x', { status: 500 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  vi.mocked(fetch).mockImplementation(real);
  // slow listings: the run is still going when a turn ends
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  vi.mocked(fetch).mockImplementation(async (u) => { if (String(u).includes('path=src')) await gate; return real(u as string); });
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
  calls.length = 0;
  live(store, turnEnd());
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.filter((u) => u === '/tree?path=')).toEqual([]); // no refresh across the run
  release();
  await row('deep.ts');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Expand all' })).not.toHaveAttribute('aria-disabled', 'true'));
  await waitFor(() => expect(calls).toContain('/tree?path=')); // the missed refresh, after it
  expect([...store.getState().tree.dirs].sort()).toEqual(['src', 'src/lib']);
});

it('refresh lists only shown folders; a folder under a closed parent is not fetched until shown (M6-10 review)', async () => {
  const store = setup();
  fireEvent.click(await row('src'));
  fireEvent.click(await row('lib'));
  await row('deep.ts');
  fireEvent.click(screen.getByRole('button', { name: /^src/ })); // close the parent; src/lib stays "open" below it
  expect(store.getState().tree.dirs).toContain('src/lib');
  calls.length = 0;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(calls).toContain('/tree?path='));
  expect(calls.some((u) => u.includes('path=src%2Flib'))).toBe(false);
});
