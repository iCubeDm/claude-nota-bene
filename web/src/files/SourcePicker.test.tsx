import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerEvent, Source, TreeEntry } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { revealFile, selectTree, setTreeOpen } from '@/tree/slice.ts';
import { selectActiveTab, selectTabs } from '@/tabs/slice.ts';
import { resetSources } from './sources.ts';
import { FileTree } from './FileTree.tsx';

// M3-16: the source picker at the top of the tree sheet
const SOURCES: Source[] = [
  { id: 'here', kind: 'checkout', label: 'main', ref: 'main', dir: '/p/main' },
  { id: 'ref:feature/x', kind: 'worktree', label: 'feature/x', ref: 'feature/x', dir: '/p/wt-x' },
  { id: 'ref:old', kind: 'branch', label: 'old', ref: 'old' },
];
let fs: Record<string, Record<string, TreeEntry[]>>;
let calls: string[];
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  resetSources();
  calls = [];
  fs = {
    here: { '': [{ name: 'src', dir: true }, { name: 'a.md', dir: false }], src: [{ name: 'main.ts', dir: false }] },
    'ref:feature/x': { '': [{ name: 'xdir', dir: true }, { name: 'only-x.md', dir: false }], xdir: [{ name: 'deep.md', dir: false }] },
    'ref:old': { '': [{ name: 'old-only.md', dir: false }] },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    if (u.pathname === '/sources') return new Response(JSON.stringify(SOURCES));
    const list = fs[u.searchParams.get('src') ?? 'here']?.[u.searchParams.get('path') ?? ''];
    return new Response(JSON.stringify(list ?? []), { status: list ? 200 : 404 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  act(() => void store.dispatch(serverEvent({ kind: 'session', id: null, root: '/p/main' })));
  store.dispatch(setTreeOpen(true));
  render(<Provider store={store}><FileTree /></Provider>);
  return store;
}
const picker = () => screen.findByRole('combobox', { name: 'Source' });
const row = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name.replace(/[+.]/g, '\\$&')}`) });
const result = (): ServerEvent => ({ kind: 'sdk', ts: 1, m: { type: 'result', subtype: 'success', duration_ms: 1 } } as unknown as ServerEvent);

it('lists this folder, the worktree and the branch; picking one loads its tree and opens files from it', async () => {
  const store = setup();
  const sel = await picker();
  await waitFor(() => expect([...(sel as HTMLSelectElement).options].map((o) => o.value)).toEqual(['here', 'ref:feature/x', 'ref:old']));
  expect((sel as HTMLSelectElement).options[0].text).toContain('this folder');
  expect((sel as HTMLSelectElement).options[1].text).toContain('feature/x');
  fireEvent.change(sel, { target: { value: 'ref:feature/x' } });
  fireEvent.click(await row('only-x.md'));
  expect(calls).toContain('/tree?path=&src=ref%3Afeature%2Fx');
  expect(selectActiveTab(store.getState())).toEqual({ id: 'file:ref:feature/x:only-x.md', kind: 'file', path: 'only-x.md', src: 'ref:feature/x', ref: 'feature/x' });
  expect(screen.queryByRole('button', { name: /^a\.md/ })).toBeNull();
});

it('keeps a separate set of open folders per source', async () => {
  const store = setup();
  fireEvent.click(await row('src'));
  await row('main.ts');
  fireEvent.change(await picker(), { target: { value: 'ref:feature/x' } });
  await row('only-x.md');
  expect(selectTree(store.getState()).dirs).toEqual([]);
  fireEvent.click(await row('xdir'));
  await row('deep.md');
  fireEvent.change(await picker(), { target: { value: 'here' } });
  await row('main.ts'); // src is open again
  expect(selectTree(store.getState()).dirs).toEqual(['src']);
  fireEvent.change(await picker(), { target: { value: 'ref:feature/x' } });
  await row('deep.md');
});

it('a branch source does not refresh after a turn; a worktree does', async () => {
  const store = setup();
  fireEvent.change(await picker(), { target: { value: 'ref:old' } });
  await row('old-only.md');
  const n = calls.filter((u) => u.startsWith('/tree')).length;
  act(() => void store.dispatch(serverEvent(result())));
  await new Promise((r) => setTimeout(r, 20));
  expect(calls.filter((u) => u.startsWith('/tree')).length).toBe(n);
  fireEvent.change(await picker(), { target: { value: 'ref:feature/x' } });
  await row('only-x.md');
  const m = calls.filter((u) => u.startsWith('/tree')).length;
  act(() => void store.dispatch(serverEvent(result())));
  await waitFor(() => expect(calls.filter((u) => u.startsWith('/tree')).length).toBeGreaterThan(m));
});

it('reveal switches to the tab’s source and clears an active filter so the row is visible', async () => {
  const store = setup();
  await picker();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
  act(() => void store.dispatch(revealFile('xdir/deep.md', 'ref:feature/x')));
  expect(selectTree(store.getState()).src).toBe('ref:feature/x');
  await row('deep.md');
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  expect(selectTabs(store.getState()).open).toHaveLength(1);
});
