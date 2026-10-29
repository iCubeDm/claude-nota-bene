import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent, WireAgentEvent } from '@nota-bene/shared';
import { App } from '@/App.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { selectTabs } from '@/tabs/slice.ts';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { selectDrawerOpen, setDrawer } from './slice.ts';
import { TasksDrawer } from './TasksDrawer.tsx';
import { STOP_CONFIRM_MS, STOP_WAIT_MS } from './TaskButtons.tsx';

type Task = Extract<WireAgentEvent, { t: 'task' }>;

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(100_000);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(protocol = 8) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: (m) => (sent.push(m), true), close() {} }) });
  const ev = (e: ServerEvent) => act(() => void store.dispatch(serverEvent(e)));
  ev({ kind: 'session', id: 's1', root: '/p', title: null, model: null });
  if (protocol) ev({ kind: 'hello', protocol });
  const task = (e: Task, ts = Date.now()) => ev({ kind: 'agent', e, ts });
  const tool = (id: string, withResult: boolean) => {
    ev({ kind: 'agent', ts: 1, e: { t: 'tool-call', id, name: 'Bash', input: { command: 'sleep 60' }, sub: false } });
    if (withResult) ev({ kind: 'agent', ts: 2, e: { t: 'tool-update', id, text: 'ok', isError: false } });
  };
  render(<Provider store={store}><App /></Provider>);
  return { store, sent, ev, task, tool };
}
const start = (id: string, extra: Partial<Task> = {}): Task => ({ t: 'task', phase: 'started', id, desc: `desc ${id}`, type: 'local_bash', ...extra });
const indicator = () => document.getElementById('tasks-indicator');
const drawer = () => document.querySelector('[data-tasks-drawer]');
const row = (id: string) => document.querySelector<HTMLElement>(`[data-task="${id}"]`)!;
const alt = (code: string, target: Element | Document = document.body) => fireEvent.keyDown(target, { code, key: code, altKey: true, bubbles: true });

describe('the indicator', () => {
  it('is hidden with no tasks; N counts the running ones and pulses; finished ones show quietly as a check', () => {
    const { task } = setup();
    expect(indicator()).toBeNull();
    task(start('a')); task(start('b'));
    expect(indicator()).toHaveTextContent('2 tasks');
    expect(indicator()!.querySelector('.animate-pulse')).not.toBeNull();
    task({ t: 'task', id: 'a', phase: 'done' });
    expect(indicator()).toHaveTextContent('1 task');
    expect(indicator()).not.toHaveTextContent('1 tasks');
    task({ t: 'task', id: 'b', phase: 'done', status: 'stopped' });
    expect(indicator()).toHaveTextContent('✓2');
    expect(indicator()!.querySelector('.animate-pulse')).toBeNull();
  });

  it('only a watcher is running: a quiet variant (no pulse) keeps the drawer reachable', () => {
    const { task } = setup();
    task(start('w', { ambient: true }));
    expect(indicator()).toHaveTextContent('1 watcher');
    expect(indicator()!.querySelector('.animate-pulse')).toBeNull();
    expect(indicator()).not.toHaveAttribute('data-running');
    fireEvent.click(indicator()!);
    expect(row('w')).not.toBeNull();
    task(start('r')); // real work shows the usual count, the watcher stays out of it
    expect(indicator()).toHaveTextContent('1 task');
  });

  it('in Russian: the plural forms', () => {
    setLang('ru');
    const { task } = setup();
    task(start('a'));
    expect(indicator()).toHaveTextContent('1 задача');
    for (const id of ['b', 'c']) task(start(id));
    expect(indicator()).toHaveTextContent('3 задачи');
    for (const id of ['d', 'e']) task(start(id));
    expect(indicator()).toHaveTextContent('5 задач');
  });
});

describe('the drawer opens and closes', () => {
  it('a click on the indicator toggles it; Alt+T toggles it, in a text field too', () => {
    const { store, task } = setup();
    task(start('a'));
    expect(drawer()).toBeNull();
    fireEvent.click(indicator()!);
    expect(drawer()).not.toBeNull();
    expect(indicator()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(indicator()!);
    expect(drawer()).toBeNull();
    alt('KeyT');
    expect(selectDrawerOpen(store.getState())).toBe(true);
    alt('KeyT', document.getElementById('composer-input')!);
    expect(selectDrawerOpen(store.getState())).toBe(false);
  });

  it('Esc closes it and the composer\'s Esc (interrupt) does not also fire', () => {
    const { store, sent, task, ev } = setup();
    task(start('a'));
    ev({ kind: 'user', id: 'u1', text: 'go', ts: 1 }); // busy: the composer would interrupt on Esc
    fireEvent.click(indicator()!);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape', bubbles: true });
    expect(selectDrawerOpen(store.getState())).toBe(false);
    expect(sent.some((m) => m.type === 'interrupt')).toBe(false);
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape', bubbles: true }); // second Esc: the usual meaning
    expect(sent.some((m) => m.type === 'interrupt')).toBe(true);
  });

  it('a click outside closes it; a click inside does not', () => {
    const { store, task } = setup();
    task(start('a'));
    fireEvent.click(indicator()!);
    fireEvent.mouseDown(within(drawer() as HTMLElement).getByText('desc a'));
    expect(selectDrawerOpen(store.getState())).toBe(true);
    fireEvent.mouseDown(document.querySelector('[data-pane="chat"]')!);
    expect(selectDrawerOpen(store.getState())).toBe(false);
  });

  it('it overlays the feed: absolutely positioned inside the pane column, the feed keeps its place', () => {
    const { task } = setup();
    task(start('a'));
    fireEvent.click(indicator()!);
    expect(drawer()!.className).toMatch(/\babsolute\b/);
    expect(drawer()!.parentElement!.contains(document.querySelector('[data-pane="chat"]'))).toBe(true);
  });
});

describe('rows', () => {
  it('one row per task: status, description, type, elapsed (live for a running one), tokens, last tool, summary with the full text in title', () => {
    const { task } = setup();
    task(start('a'), 100_000);
    task({ t: 'task', id: 'a', phase: 'progress', tokens: 45678, tool: 'Grep', summary: 'a long summary of what is going on' }, 100_000);
    fireEvent.click(indicator()!);
    expect(row('a')).toHaveTextContent('desc a');
    expect(row('a').querySelector('[data-task-meta]')).toHaveTextContent('local_bash · 0s · 46k tok · Grep');
    expect(row('a').querySelector('[data-task-summary]')).toHaveAttribute('title', 'a long summary of what is going on');
    expect(row('a').querySelector('[data-task-status]')).toHaveAttribute('aria-label', 'running');
    act(() => void vi.advanceTimersByTime(65_000));
    expect(row('a').querySelector('[data-task-meta]')).toHaveTextContent('1:05');
  });

  it('a finished row shows how it ended and its duration, and stops ticking', () => {
    const { task } = setup();
    task(start('a'), 100_000);
    task({ t: 'task', id: 'a', phase: 'done', status: 'failed' }, 107_000);
    fireEvent.click(indicator()!);
    expect(row('a')).toHaveAttribute('data-status', 'failed');
    expect(row('a').querySelector('[data-task-meta]')).toHaveTextContent('7s');
    act(() => void vi.advanceTimersByTime(30_000));
    expect(row('a').querySelector('[data-task-meta]')).toHaveTextContent('7s');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('children nest under their parent', () => {
    const { task } = setup();
    task(start('p', { type: 'local_agent', call: 'toolu_P' }));
    task(start('k', { parent: 'p' }));
    fireEvent.click(indicator()!);
    expect(row('p').style.paddingLeft).toBe('12px');
    expect(row('k').style.paddingLeft).toBe('30px');
    expect([...document.querySelectorAll('[data-task]')].map((n) => n.getAttribute('data-task'))).toEqual(['p', 'k']);
  });

  it('empty drawer (all tasks gone with a reset) says so', () => {
    const { task, ev } = setup();
    task(start('a'));
    fireEvent.click(indicator()!);
    ev({ kind: 'agent', ts: 5, e: { t: 'reset' } });
    expect(screen.getByText('No tasks.')).toBeInTheDocument();
  });
});

describe('actions', () => {
  it('Open: an agent task opens its agent tab, a shell task a shell tab, any other task has no Open; the drawer closes', () => {
    const { store, task } = setup();
    task(start('ag', { type: 'local_agent', call: 'toolu_AG', desc: 'Explore' }));
    task(start('sh', { desc: 'tail -f log' }));
    task(start('wf', { type: 'local_workflow' }));
    fireEvent.click(indicator()!);
    expect(row('wf').querySelector('[data-task-open]')).toBeNull();
    fireEvent.click(row('sh').querySelector('[data-task-open]')!);
    expect(selectTabs(store.getState()).active).toBe('shell:sh');
    expect(selectTabs(store.getState()).open.find((t) => t.id === 'shell:sh')).toMatchObject({ kind: 'shell', task: 'sh', title: 'tail -f log' });
    expect(drawer()).toBeNull();
    fireEvent.click(indicator()!);
    fireEvent.click(row('ag').querySelector('[data-task-open]')!);
    expect(selectTabs(store.getState()).active).toBe('agent:toolu_AG');
  });

  it('Stop asks first ("Stop?" for 3 s), the second click sends task-stop; the button goes back after the time', () => {
    const { sent, task } = setup();
    task(start('a'));
    fireEvent.click(indicator()!);
    const stop = () => row('a').querySelector<HTMLElement>('[data-task-stop]')!;
    fireEvent.click(stop());
    expect(stop()).toHaveTextContent('Stop?');
    expect(sent.filter((m) => m.type === 'task-stop')).toEqual([]);
    act(() => void vi.advanceTimersByTime(STOP_CONFIRM_MS + 10));
    expect(stop()).toHaveTextContent('Stop');
    expect(stop()).not.toHaveTextContent('Stop?');
    fireEvent.click(stop());
    fireEvent.click(stop());
    expect(sent.filter((m) => m.type === 'task-stop')).toEqual([{ type: 'task-stop', id: 'a' }]);
    expect(stop()).not.toHaveTextContent('Stop?');
  });

  it('Stop is for running tasks only', () => {
    const { task } = setup();
    task(start('a')); task({ t: 'task', id: 'a', phase: 'done' });
    fireEvent.click(indicator()!);
    expect(row('a').querySelector('[data-task-stop]')).toBeNull();
  });

  it('To background: when the CLI says bg:false it is offered, bg:true never; it sends task-background with the call', () => {
    const { sent, task, tool } = setup();
    tool('toolu_FG', false); tool('toolu_BG', false);
    task(start('fg', { call: 'toolu_FG', bg: false })); task(start('bg', { call: 'toolu_BG', bg: true })); task(start('nocall', { bg: false }));
    fireEvent.click(indicator()!);
    expect(row('bg').querySelector('[data-task-background]')).toBeNull(); // in the background whatever the feed says
    expect(row('nocall').querySelector('[data-task-background]')).toBeNull();
    fireEvent.click(row('fg').querySelector('[data-task-background]')!);
    expect(sent.filter((m) => m.type === 'task-background')).toEqual([{ type: 'task-background', toolUseId: 'toolu_FG' }]);
    // a later move to the background (task_updated) takes the button away
    task({ t: 'task', id: 'fg', phase: 'updated', bg: true });
    expect(row('fg').querySelector('[data-task-background]')).toBeNull();
  });

  it('bg not said by the CLI: the call having no result stands in, but a main-thread task is not foreground once the turn is over', () => {
    const { task, tool, ev } = setup();
    tool('toolu_A', false); tool('toolu_B', true); tool('toolu_C', false);
    task(start('a', { call: 'toolu_A' })); task(start('b', { call: 'toolu_B' })); task(start('c', { call: 'toolu_C', parent: 'p' }));
    task(start('p', { type: 'local_agent' }));
    fireEvent.click(indicator()!);
    const has = (id: string) => !!row(id).querySelector('[data-task-background]');
    expect([has('a'), has('b'), has('c')]).toEqual([false, false, true]); // the turn is over: only the subagent's child may still block
    ev({ kind: 'user', id: 'u1', text: 'go', ts: 1 }); // a turn is running
    expect([has('a'), has('b'), has('c')]).toEqual([true, false, true]);
  });

  it('Stop waits for its answer: "Stopping…", disabled, no second send; a refusal from the server offers it again', () => {
    const { sent, task, ev } = setup();
    task(start('a'));
    fireEvent.click(indicator()!);
    const stop = () => row('a').querySelector<HTMLButtonElement>('[data-task-stop]')!;
    fireEvent.click(stop()); fireEvent.click(stop());
    expect(stop()).toHaveTextContent('Stopping…');
    expect(stop().disabled).toBe(true);
    fireEvent.click(stop());
    expect(sent.filter((m) => m.type === 'task-stop')).toHaveLength(1);
    ev({ kind: 'server-error', where: 'task', message: 'cannot stop a' });
    expect(stop()).toHaveTextContent('Stop');
    expect(stop().disabled).toBe(false);
    fireEvent.click(stop()); fireEvent.click(stop());
    expect(stop()).toHaveTextContent('Stopping…');
    act(() => void vi.advanceTimersByTime(STOP_WAIT_MS + 10)); // no answer at all: not stuck for ever
    expect(stop()).toHaveTextContent('Stop');
  });

  it('Open is not offered for a remote agent (it has no subagent conversation here)', () => {
    const { task } = setup();
    task(start('r', { type: 'remote_agent', call: 'toolu_R' })); task(start('l', { type: 'local_agent', call: 'toolu_L' }));
    fireEvent.click(indicator()!);
    expect(row('r').querySelector('[data-task-open]')).toBeNull();
    expect(row('l').querySelector('[data-task-open]')).not.toBeNull();
  });

  it('a watcher (ambient shell) is listed but not counted; a running child of a finished parent stays with the running rows', () => {
    const { task } = setup();
    task(start('w', { ambient: true }));
    expect(indicator()).toHaveTextContent('1 watcher'); // nothing but a watcher: the quiet variant
    task(start('p', { type: 'local_agent' })); task(start('k', { parent: 'p' })); task(start('o')); task({ t: 'task', id: 'p', phase: 'done' });
    expect(indicator()).toHaveTextContent('2 tasks'); // k and o, not w
    fireEvent.click(indicator()!);
    // the finished parent leads its running child, and both stay above the finished block (here there is none left)
    expect([...document.querySelectorAll('[data-task]')].map((n) => n.getAttribute('data-task'))).toEqual(['w', 'o', 'p', 'k']);
  });

  it('a server older than protocol 8 gets no Stop and no To background (absent, not disabled); Open of a shell is absent too', () => {
    for (const protocol of [0, 7]) {
      cleanup();
      const { task, tool } = setup(protocol);
      tool('toolu_FG', false);
      task(start('a', { call: 'toolu_FG' }));
      fireEvent.click(indicator()!);
      expect(row('a').querySelector('[data-task-stop]')).toBeNull();
      expect(row('a').querySelector('[data-task-background]')).toBeNull();
      expect(row('a').querySelector('[data-task-open]')).toBeNull();
    }
  });
});

describe('Esc and the comment popup', () => {
  it('the REAL comment popup: typing in it, Alt+T, Esc closes only the drawer and the draft survives; the next Esc closes the popup', async () => {
    cleanup();
    const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
    store.dispatch(serverEvent({ kind: 'hello', protocol: 8 }));
    store.dispatch(serverEvent({ kind: 'agent', ts: 1, e: { t: 'task', phase: 'started', id: 'a', desc: 'a', type: 'local_bash' } }));
    const onClose = vi.fn();
    const pending = { anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 1, quote: 'x', prefix: '', suffix: '' }, rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } } as never;
    render(<Provider store={store}><TooltipProvider><TasksDrawer /><CommentPopup pending={pending} onClose={onClose} /></TooltipProvider></Provider>);
    const area = screen.getByPlaceholderText('Comment…') as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: 'my draft' } });
    act(() => void store.dispatch(setDrawer(true))); // Alt+T from inside the field does this
    expect(drawer()).not.toBeNull();
    fireEvent.keyDown(area, { key: 'Escape', code: 'Escape', bubbles: true });
    expect(selectDrawerOpen(store.getState())).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(area.value).toBe('my draft');
    fireEvent.keyDown(area, { key: 'Escape', code: 'Escape', bubbles: true }); // drawer closed: the popup behaves as before
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('one Esc closes one layer: the drawer first, the draft in an open popup survives', () => {
    const { store, task } = setup();
    task(start('a'));
    fireEvent.click(indicator()!);
    const popup = document.createElement('div');
    let popupEsc = 0;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') popupEsc++; }); // what CommentPopup does: a document listener
    document.body.append(popup);
    fireEvent.keyDown(popup, { key: 'Escape', code: 'Escape', bubbles: true });
    expect(selectDrawerOpen(store.getState())).toBe(false);
    expect(popupEsc).toBe(0);
    fireEvent.keyDown(popup, { key: 'Escape', code: 'Escape', bubbles: true }); // the next Esc is the popup's
    expect(popupEsc).toBe(1);
  });
});
