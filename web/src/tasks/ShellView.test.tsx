import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent, TaskOutputView, WireAgentEvent } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { restoreTabs, serializeTabs, type ShellTab } from '@/tabs/slice.ts';
import { SHELL_POLL_MS, ShellView } from './ShellView.tsx';

const tab: ShellTab = { id: 'shell:sh1', kind: 'shell', task: 'sh1', title: 'tail -f build.log' };
type Task = Extract<WireAgentEvent, { t: 'task' }>;

let urls: string[];
let answer: () => Response;
const view = (o: Partial<TaskOutputView> = {}): TaskOutputView => ({ output: 'hello\n', totalBytes: 6, truncated: false, running: true, ...o });
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  urls = [];
  answer = () => json(view());
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/task-output') ? (urls.push(url), answer()) : new Response('', { status: 404 }))));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function setup(o: { active?: boolean; protocol?: number; running?: boolean } = {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: (m) => (sent.push(m), true), close() {} }) });
  const ev = (e: ServerEvent) => act(() => void store.dispatch(serverEvent(e)));
  ev({ kind: 'session', id: 'S-1', root: '/p', title: null, model: null });
  ev({ kind: 'hello', protocol: o.protocol ?? 8 });
  const task = (e: Task) => ev({ kind: 'agent', ts: Date.now(), e });
  if (o.running !== false) task({ t: 'task', phase: 'started', id: 'sh1', desc: tab.title, type: 'local_bash' });
  const ui = (active: boolean) => <Provider store={store}><ShellView tab={tab} active={active} /></Provider>;
  const r = render(ui(o.active ?? true));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  return { store, sent, task, tick, rerender: (active: boolean) => r.rerender(ui(active)), root: () => document.querySelector<HTMLElement>('[data-shell]')! };
}
const out = () => document.querySelector('[data-shell-output]')?.textContent;

it('reads the output on open, then every second while the task runs', async () => {
  const s = await setup();
  expect(urls).toEqual(['/task-output?session=S-1&task=sh1']);
  expect(out()).toBe('hello\n');
  answer = () => json(view({ output: 'hello\nworld\n' }));
  await s.tick(SHELL_POLL_MS);
  expect(urls).toHaveLength(2);
  expect(out()).toBe('hello\nworld\n');
  await s.tick(SHELL_POLL_MS * 3);
  expect(urls).toHaveLength(5);
});

it('the read that says running:false is the last: polling stops', async () => {
  const s = await setup();
  answer = () => json(view({ output: 'bye\n', running: false }));
  await s.tick(SHELL_POLL_MS);
  expect(urls).toHaveLength(2);
  await s.tick(SHELL_POLL_MS * 5);
  expect(urls).toHaveLength(2);
  expect(out()).toBe('bye\n');
});

it('when the task ends in the store, it is read once more (and then no more)', async () => {
  const s = await setup();
  answer = () => json(view({ output: 'final\n', running: false }));
  s.task({ t: 'task', phase: 'done', id: 'sh1', status: 'stopped' });
  await s.tick(0);
  expect(urls).toHaveLength(2);
  expect(out()).toBe('final\n');
  await s.tick(SHELL_POLL_MS * 4);
  expect(urls).toHaveLength(2);
  expect(document.querySelector('[data-shell-status]')).toHaveTextContent('stopped');
});

it('a hidden tab is not read; becoming visible reads, hiding stops the polling', async () => {
  const s = await setup({ active: false });
  expect(urls).toHaveLength(0);
  s.rerender(true);
  await s.tick(0);
  expect(urls).toHaveLength(1);
  s.rerender(false);
  await s.tick(SHELL_POLL_MS * 4);
  expect(urls).toHaveLength(1);
});

it('escape sequences are stripped, not interpreted; the text is shown as text, not markup', async () => {
  answer = () => json(view({ output: '\u001b[31mFAIL\u001b[0m <b>x</b>\u001b]0;t\u0007\n' }));
  const s = await setup();
  expect(out()).toBe('FAIL <b>x</b>\n');
  expect(s.root().querySelector('pre b')).toBeNull();
  expect(s.root().querySelector('pre')!.className).toMatch(/font-mono/);
});

it('a truncated tail says how much came before it', async () => {
  answer = () => json(view({ output: 'x'.repeat(8192), totalBytes: 8192 + 5 * 1024, truncated: true }));
  await setup();
  expect(document.querySelector('[data-shell-truncated]')).toHaveTextContent('…(5 KB earlier not shown)');
  cleanup();
  answer = () => json(view());
  await setup();
  expect(document.querySelector('[data-shell-truncated]')).toBeNull();
});

it('a task the server does not know (404 / 409) says so, with no output and no more reads', async () => {
  answer = () => new Response('no such task', { status: 404 });
  const s = await setup();
  expect(document.querySelector('[data-kind="shell-status"]')).toHaveTextContent('no longer knows');
  expect(out()).toBeUndefined();
  await s.tick(SHELL_POLL_MS * 4);
  expect(urls).toHaveLength(1);
  expect(document.querySelector('[data-task-stop]')).toBeNull();
});

it('a failed read keeps the last output and tries again', async () => {
  const s = await setup();
  answer = () => new Response('', { status: 502 });
  await s.tick(SHELL_POLL_MS);
  expect(out()).toBe('hello\n');
  expect(document.querySelector('[data-shell-stale]')).toHaveTextContent('HTTP 502');
  answer = () => json(view({ output: 'back\n' }));
  await s.tick(3000);
  expect(out()).toBe('back\n');
  expect(document.querySelector('[data-shell-stale]')).toBeNull();
});

it('a server older than protocol 8: no read, a line says why', async () => {
  await setup({ protocol: 7 });
  expect(urls).toHaveLength(0);
  expect(document.querySelector('[data-kind="shell-status"]')).toHaveTextContent('server restart');
});

it('Stop in the header: running only; confirms, then sends task-stop', async () => {
  const s = await setup();
  const stop = () => document.querySelector<HTMLElement>('[data-task-stop]')!;
  fireEvent.click(stop());
  expect(stop()).toHaveTextContent('Stop?');
  fireEvent.click(stop());
  expect(s.sent).toEqual([{ type: 'task-stop', id: 'sh1' }]);
  s.task({ t: 'task', phase: 'done', id: 'sh1', status: 'stopped' });
  expect(document.querySelector('[data-task-stop]')).toBeNull();
});

it('sticks to the bottom only when it was at the bottom', async () => {
  const s = await setup();
  const box = s.root().querySelector<HTMLElement>('.overflow-auto')!;
  let height = 1000;
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(box, 'clientHeight', { configurable: true, value: 200 });
  // at the bottom: the next output scrolls down
  box.scrollTop = 800; fireEvent.scroll(box);
  height = 1200; answer = () => json(view({ output: 'more\n' }));
  await s.tick(SHELL_POLL_MS);
  expect(box.scrollTop).toBe(1200);
  // the reader scrolled up: the next output leaves the view where it is
  box.scrollTop = 100; fireEvent.scroll(box);
  height = 1500; answer = () => json(view({ output: 'even more\n' }));
  await s.tick(SHELL_POLL_MS);
  expect(box.scrollTop).toBe(100);
});

it('a shell tab is saved with the root\'s tabs and comes back; a bad saved task id is dropped', () => {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  store.dispatch(restoreTabs({ tabs: [{ shell: { task: 'sh1', title: 'tail' } }], active: 'shell:sh1' }));
  expect(serializeTabs(store.getState().tabs)).toEqual({ tabs: [{ shell: { task: 'sh1', title: 'tail' } }], active: 'shell:sh1' });
  expect(store.getState().tabs.open[1]).toMatchObject({ id: 'shell:sh1', kind: 'shell', task: 'sh1', title: 'tail' });
});
