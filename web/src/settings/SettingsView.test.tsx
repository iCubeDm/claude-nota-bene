import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { App } from '@/App.tsx';
import { selectTabs } from '@/tabs/slice.ts';

const now = Date.now();
const WINDOWS = [
  { port: 4777, root: '/Users/me/a', pid: 1, startedAt: now - 3 * 3600_000, current: true, state: 'live', session: 's', title: 'Mine', supervised: true, busy: false, clients: 1 },
  { port: 4778, root: '/Users/me/b', pid: 2, startedAt: now - 5 * 60_000, current: false, state: 'live', session: 't', title: 'Other', supervised: true, busy: true, clients: 0 },
  { port: 4779, root: '/Users/me/c', pid: 3, startedAt: now, current: false, state: 'stale', session: null, title: null, supervised: false, busy: false, clients: 0 },
];
let posts: { url: string; body: unknown }[];
let storage: { unreferenced: { files: number; bytes: number } };
beforeEach(() => {
  localStorage.clear();
  setLang('en');
  posts = [];
  storage = { unreferenced: { files: 3, bytes: 3_000_000 } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url === '/system/storage/clean') return Response.json({ moved: 3, bytes: 3_000_000, trash: '/Users/me/.nota-bene/trash/attachments/x' });
      if (url === '/system/prefs') return Response.json({ defaultMode: 'plan' });
      return Response.json({ status: 200 });
    }
    if (url === '/system/windows') return Response.json(WINDOWS);
    if (url === '/system/storage') return Response.json({ attachments: { bytes: 5e6, files: 9 }, comments: { bytes: 2e4, files: 3 }, trash: { bytes: 0, files: 0 }, marks: { bytes: 1e6, files: 4, root: '/Users/me/a' }, ...storage });
    if (url === '/system/about') return Response.json({ version: 'v0.9-12-gabc', stateDir: '/Users/me/.nota-bene', logs: [], node: 'v23.6.0', pid: 42 });
    if (url === '/system/prefs') return Response.json({ defaultMode: 'auto' });
    return new Response('[]');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><App /></Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return store;
}
const win = async (port: number) => (await screen.findByText(`:${port}`)).closest<HTMLElement>('[data-window]')!;

it('⚙ opens one Settings tab; a second click activates the same one; it closes like a file tab', () => {
  const store = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(selectTabs(store.getState()).open.filter((t) => t.kind === 'settings')).toHaveLength(1);
  expect(selectTabs(store.getState()).active).toBe('settings');
  expect(screen.getByRole('tab', { name: /Settings/ })).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('tab', { name: /Settings/ })).getByRole('button', { name: 'Close' }));
  expect(selectTabs(store.getState()).open.map((t) => t.id)).toEqual(['chat']);
});

it('Windows: this window has no actions; another live one can be restarted or stopped (after a confirmation); a stale one only says so', async () => {
  setup();
  expect(within(await win(4777)).getByText('this window')).toBeInTheDocument();
  expect(within(await win(4777)).queryByRole('button')).toBeNull();
  const other = await win(4778);
  expect(other).toHaveTextContent('Other · working · no tab · up 5 min');
  expect(within(await win(4779)).getByText('gone')).toBeInTheDocument();
  expect(within(await win(4779)).queryByRole('button')).toBeNull();
  fireEvent.click(within(other).getByRole('button', { name: 'Restart agent' }));
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/windows/action', body: { port: 4778, action: 'restart-agent' } }));
  fireEvent.click(within(other).getByRole('button', { name: 'Stop' }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('Stop the window on port 4778 (~/b)?');
  expect(posts.some((p) => (p.body as { action: string }).action === 'stop')).toBe(false); // not before the yes
  fireEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/windows/action', body: { port: 4778, action: 'stop' } }));
  expect(await screen.findByText('Done')).toHaveAttribute('role', 'status');
});

it('Storage: sizes, and the clean asks first, then reports where the files went', async () => {
  setup();
  expect(await screen.findByText('Media marks of this project')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Clean unreferenced images · 3/ }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('Move 3 images (3.0 MB)');
  expect(posts).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clean unreferenced images' }));
  expect(await screen.findByText('Moved 3 (3.0 MB) to ~/.nota-bene/trash/attachments/x')).toHaveAttribute('role', 'status');
});

it('Defaults: the mode is saved on the server; About shows the version', async () => {
  setup();
  const mode = await screen.findByRole('combobox', { name: 'Agent mode for projects without their own' });
  fireEvent.change(mode, { target: { value: 'plan' } });
  await waitFor(() => expect(posts).toContainEqual({ url: '/system/prefs', body: { defaultMode: 'plan' } }));
  expect(await screen.findByText('v0.9-12-gabc')).toBeInTheDocument();
  expect(screen.getByText(/in the Claude Code task/)).toBeInTheDocument();
  act(() => void fireEvent.change(screen.getByRole('combobox', { name: 'Interface language' }), { target: { value: 'ru' } }));
  expect(await screen.findByText('Окна')).toBeInTheDocument();
});
