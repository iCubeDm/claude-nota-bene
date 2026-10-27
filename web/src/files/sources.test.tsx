import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Comment, ServerEvent, Source } from '@nota-bene/shared';
import { App } from '@/App.tsx';
import { Markdown } from '@/feed/Markdown.tsx';
import { setLang } from '@/i18n/index.ts';
import { clearRefCache, refClick } from '@/refs/refs.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { activate, fileTabId, openFile, selectActiveTab, selectTabs } from '@/tabs/slice.ts';
import { setPanelOpen } from '@/comments/slice.ts';
import { sendBatch, whereOf } from '@/comments/send.ts';
import { FileView } from './FileView.tsx';
import { getSources, loadSources, resetSources, setSources, sourceForAbs, useSources } from './sources.ts';

function Probe({ onRender }: { onRender: () => void }) {
  useSources();
  onRender();
  return null;
}

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg></svg>' })) } }));

// M3-16 on the client: tab ids, persistence, refs, comments and views of other sources
const SOURCES: Source[] = [
  { id: 'here', kind: 'checkout', label: 'main', ref: 'main', dir: '/p/main' },
  { id: 'ref:feature/x', kind: 'worktree', label: 'feature/x', ref: 'feature/x', dir: '/p/main/.worktrees/x' },
  { id: 'ref:old', kind: 'branch', label: 'old', ref: 'old' },
];
let sources: Source[];
/** files per source id */
let files: Record<string, Record<string, string>>;
let calls: string[];
let sourcesDown: boolean;
beforeEach(() => {
  sourcesDown = false;
  localStorage.clear();
  setLang('en');
  resetSources();
  clearRefCache();
  sources = SOURCES;
  calls = [];
  files = { here: { 'a.md': 'hello brave world\n' }, 'ref:feature/x': { 'only-x.md': 'x file', 'a.md': 'hello brave world\n' }, 'ref:old': { 'a.md': 'hello brave world\n' } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(url, 'http://x');
    if (u.pathname === '/sources') return sourcesDown ? new Response('down', { status: 500 }) : new Response(JSON.stringify(sources));
    const src = u.searchParams.get('src');
    if (src && !sources.some((x) => x.id === src)) return new Response('unknown source', { status: 400 });
    const body = u.pathname === '/file' ? files[u.searchParams.get('src') ?? 'here']?.[u.searchParams.get('path') ?? ''] : undefined;
    if (body === undefined) return new Response('nope', { status: 404 });
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(body.length) } });
    return new Response(body, { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
});

function mk() {
  let onEvent!: (e: ServerEvent) => void;
  const sent: ClientMessage[] = [];
  const store = makeStore({
    url: 'u',
    connect: ((_u: string, e: typeof onEvent, onState: (s: 'open') => void) => ((onEvent = e), onState('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never,
  });
  return { store, sent, session: (root: string) => act(() => onEvent({ kind: 'session', id: null, root, title: null, model: null })) };
}
const ids = (s: ReturnType<typeof mk>['store']) => selectTabs(s.getState()).open.map((t) => t.id);
const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));

it('tab ids: this folder keeps file:<path>; another source is file:<src>:<path> and the tab stores src and ref', () => {
  const { store } = mk();
  expect(fileTabId('a.md')).toBe('file:a.md');
  expect(fileTabId('a.md', 'here')).toBe('file:a.md');
  expect(fileTabId('a.md', 'ref:old')).toBe('file:ref:old:a.md');
  store.dispatch(openFile('a.md'));
  store.dispatch(openFile({ path: 'a.md', src: 'ref:old', ref: 'old' }));
  expect(ids(store)).toEqual(['chat', 'file:a.md', 'file:ref:old:a.md']);
  expect(selectActiveTab(store.getState())).toEqual({ id: 'file:ref:old:a.md', kind: 'file', path: 'a.md', src: 'ref:old', ref: 'old' });
});

it('a reload while /sources fails keeps every saved tab, visible and persisted', async () => {
  const a = mk();
  a.session('/p/main');
  a.store.dispatch(openFile('a.md'));
  a.store.dispatch(openFile({ path: 'only-x.md', src: 'ref:feature/x', ref: 'feature/x' }));
  a.store.dispatch(openFile({ path: 'gone.md', src: 'ref:gone', ref: 'gone' }));
  a.store.dispatch(activate(fileTabId('only-x.md', 'ref:feature/x')));
  const saved = localStorage.getItem('tabs:/p/main');
  sourcesDown = true;
  resetSources();
  const b = mk();
  b.session('/p/main');
  const want = ['chat', 'file:a.md', 'file:ref:feature/x:only-x.md', 'file:ref:gone:gone.md'];
  expect(ids(b.store)).toEqual(want); // at once, without waiting for /sources
  expect(selectTabs(b.store.getState()).active).toBe('file:ref:feature/x:only-x.md');
  await tick();
  await tick();
  expect(ids(b.store)).toEqual(want);
  expect(localStorage.getItem('tabs:/p/main')).toBe(saved);
});

it('a tab whose branch was deleted stays and its view says the source is gone', async () => {
  const { store } = mk();
  setSources(SOURCES);
  store.dispatch(openFile({ path: 'gone.md', src: 'ref:gone', ref: 'gone' }));
  render(<Provider store={store}><FileView path="gone.md" src="ref:gone" refName="gone" active /></Provider>);
  expect(await screen.findByText('This branch or worktree no longer exists')).toBeTruthy();
  expect(document.querySelector('[data-tab]')).toBeNull(); // (no strip here) the tab itself is still open:
  expect(ids(store)).toContain('file:ref:gone:gone.md');
});

it('setSources notifies only when the list changed', () => {
  setSources(SOURCES);
  const seen: number[] = [];
  render(<Probe onRender={() => seen.push(1)} />);
  const n = seen.length;
  act(() => setSources(SOURCES.map((x) => ({ ...x }))));
  expect(seen.length).toBe(n);
  act(() => setSources(SOURCES.slice(0, 2)));
  expect(seen.length).toBe(n + 1);
});

it('absolute paths match the realpath dir or the form the server was started with', () => {
  const list: Source[] = [{ id: 'here', kind: 'checkout', label: 'm', ref: 'main', dir: '/private/var/p', alias: '/var/p' }];
  expect(sourceForAbs('/var/p/a.md', list)).toEqual({ src: 'here', path: 'a.md' });
  expect(sourceForAbs('/private/var/p/a.md', list)).toEqual({ src: 'here', path: 'a.md' });
  expect(sourceForAbs('/var/pa.md', list)).toBeNull();
});

it('legacy saved tabs (paths only) still restore', () => {
  localStorage.setItem('tabs:/r1', JSON.stringify({ paths: ['a.md'], active: 'file:a.md' }));
  const m = mk();
  m.session('/r1');
  expect(ids(m.store)).toEqual(['chat', 'file:a.md']);
});

it('an absolute path inside a worktree dir in a reply opens from that worktree', async () => {
  setSources(SOURCES);
  const { store } = mk();
  render(
    <Provider store={store}>
      <div onClick={(e) => refClick(e, store.dispatch)}>
        <Markdown text={'see `/p/main/.worktrees/x/only-x.md` and `/p/main/a.md` and `/etc/passwd`'} final />
      </div>
    </Provider>,
  );
  const [wt, here, other] = [...document.querySelectorAll('code')] as HTMLElement[];
  expect(wt.dataset.path).toBe('only-x.md'); // the longest dir wins: the worktree sits inside this folder
  expect(wt.dataset.src).toBe('ref:feature/x');
  expect(here.dataset.path).toBe('a.md');
  expect(other.classList.contains('ref')).toBe(false);
  fireEvent.click(wt);
  await tick();
  expect(selectActiveTab(store.getState())).toMatchObject({ id: 'file:ref:feature/x:only-x.md', src: 'ref:feature/x', ref: 'feature/x' });
});

it('an absolute ref is marked once the sources arrive', async () => {
  render(<Markdown text={'see `/p/main/.worktrees/x/only-x.md`'} final />);
  expect(document.querySelector('code.ref')).toBeNull();
  act(() => setSources(SOURCES));
  await waitFor(() => expect(document.querySelector<HTMLElement>('code.ref')?.dataset.src).toBe('ref:feature/x'));
});

it('a relative ref missing in this folder is tried in the worktrees; the first hit wins', async () => {
  setSources(SOURCES);
  const { store } = mk();
  render(
    <Provider store={store}>
      <div onClick={(e) => refClick(e, store.dispatch)} dangerouslySetInnerHTML={{ __html: '<code class="ref" data-path="only-x.md">only-x.md</code>' }} />
    </Provider>,
  );
  fireEvent.click(screen.getByText('only-x.md'));
  await waitFor(() => expect(selectActiveTab(store.getState())).toMatchObject({ src: 'ref:feature/x', path: 'only-x.md' }));
  expect(calls.filter((c) => c.startsWith('HEAD'))).toEqual(['HEAD /file?path=only-x.md', 'HEAD /file?path=only-x.md&src=ref%3Afeature%2Fx']);
});

it('a branch view: chip in the toolbar, src in the url, data-file-ref on the pane, no reload after a turn', async () => {
  const { store } = mk();
  setSources(SOURCES);
  render(<Provider store={store}><FileView path="a.md" src="ref:old" refName="old" active /></Provider>);
  await waitFor(() => expect(document.querySelector('[data-file-path="a.md"]')?.textContent).toContain('hello brave'));
  const paneEl = document.querySelector<HTMLElement>('[data-pane="file:ref:old:a.md"]')!;
  expect(paneEl.dataset.fileRef).toBe('old');
  expect(screen.getByText('old', { selector: '[data-src-chip]' }).title).toBe('read-only');
  expect(calls).toContain('GET /file?path=a.md&src=ref%3Aold');
  const n = calls.length;
  act(() => void store.dispatch(serverEvent({ kind: 'agent', ts: 1, e: { t: 'turn-end', stop: 'done', secs: 0, answers: 'none', queued: 0 } })));
  await tick();
  expect(calls.length).toBe(n);
});

const old = (o: Partial<Comment> = {}): Comment => ({
  id: 'b1', anchor: { source: { kind: 'file', path: 'a.md', ref: 'old' }, start: 6, end: 11, quote: 'brave', prefix: 'hello ', suffix: ' world' },
  text: 'on old', status: 'pending', createdAt: 1, ...o,
});

it('a comment on a branch file: batch line says path @ ref', () => {
  expect(whereOf(old())).toBe('a.md @ old');
  const { store, sent } = mk();
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [old()] })));
  store.dispatch(sendBatch(false));
  expect((sent.find((m) => m.type === 'send') as Extract<ClientMessage, { type: 'send' }>).text).toContain('1. [a.md @ old]\n> brave');
});

it('a selection in a branch view anchors with its ref; its mark never paints in a.md of this folder', async () => {
  setSources(SOURCES);
  const rect = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON() {} } as DOMRect;
  Range.prototype.getClientRects = function () { return [rect] as unknown as DOMRectList; };
  Range.prototype.getBoundingClientRect = function () { return rect; };
  const { store } = mk();
  store.dispatch(openFile('a.md'));
  store.dispatch(openFile({ path: 'a.md', src: 'ref:old', ref: 'old' }));
  store.dispatch(setPanelOpen(true));
  render(<Provider store={store}><App /></Provider>);
  const root = await waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-pane="file:ref:old:a.md"][data-file-path="a.md"]');
    expect(el?.textContent).toContain('brave');
    return el!;
  });
  const t = root.querySelector('p')!.firstChild!;
  const r = document.createRange();
  r.setStart(t, 6);
  r.setEnd(t, 11);
  window.getSelection()!.addRange(r);
  fireEvent.mouseUp(root);
  fireEvent.click(await screen.findByRole('button', { name: '💬 Comment' }));
  fireEvent.change(await screen.findByPlaceholderText('Comment…'), { target: { value: 'on old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  const c = store.getState().comments.items[0];
  expect(c.anchor.source).toEqual({ kind: 'file', path: 'a.md', ref: 'old' });
  await waitFor(() => expect(document.querySelectorAll('[data-pane="file:ref:old:a.md"] [data-hl]').length).toBeGreaterThan(0));
  expect(document.querySelector('[data-tab="file:ref:old:a.md"] [data-src-chip]')?.textContent).toBe('old');
  expect(document.querySelector('[data-tab="file:ref:old:a.md"] [data-badge]')?.textContent).toBe('1');
  expect(document.querySelector('[data-tab="file:a.md"] [data-badge]')).toBeNull();
  act(() => void store.dispatch(activate(fileTabId('a.md'))));
  await waitFor(() => expect(document.querySelector('[data-pane="file:a.md"]')?.textContent).toContain('brave'));
  await tick();
  expect(document.querySelectorAll('[data-pane="file:a.md"] [data-hl]')).toHaveLength(0);
  delete (Range.prototype as Partial<Range>).getClientRects;
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

it('a comment without a ref never paints in the same path of a ref: pane', async () => {
  setSources(SOURCES);
  const rect = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON() {} } as DOMRect;
  Range.prototype.getClientRects = function () { return [rect] as unknown as DOMRectList; };
  Range.prototype.getBoundingClientRect = function () { return rect; };
  const { store } = mk();
  const plain: Comment = { ...old(), id: 'h1', anchor: { ...old().anchor, source: { kind: 'file', path: 'a.md' } } };
  act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [plain] })));
  store.dispatch(openFile('a.md'));
  store.dispatch(openFile({ path: 'a.md', src: 'ref:old', ref: 'old' }));
  render(<Provider store={store}><App /></Provider>);
  await waitFor(() => expect(document.querySelector('[data-pane="file:ref:old:a.md"]')?.textContent).toContain('brave'));
  await tick();
  expect(document.querySelectorAll('[data-pane="file:ref:old:a.md"] [data-hl]')).toHaveLength(0);
  act(() => void store.dispatch(activate(fileTabId('a.md'))));
  await waitFor(() => expect(document.querySelectorAll('[data-pane="file:a.md"] [data-hl]').length).toBeGreaterThan(0));
  delete (Range.prototype as Partial<Range>).getClientRects;
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
});

it('loadSources(true) starts a fresh request and drops the answer still in flight (a switch to another root)', async () => {
  const r1: Source[] = [{ id: 'here', kind: 'checkout', label: 'r1', ref: 'main' }, { id: 'ref:old-root', kind: 'branch', label: 'o', ref: 'o' }];
  const r2: Source[] = [{ id: 'here', kind: 'checkout', label: 'r2', ref: 'main' }];
  const answers: ((s: Source[]) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => answers.push((s) => res(new Response(JSON.stringify(s)))))));
  const first = loadSources();
  const second = loadSources(true);
  expect(answers).toHaveLength(2);
  answers[1](r2);
  await second;
  answers[0](r1);
  await first;
  expect(getSources()).toEqual(r2);
});
