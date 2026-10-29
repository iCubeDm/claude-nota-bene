import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';

const ev = (e: Extract<ServerEvent, { kind: 'agent' }>['e']): ServerEvent => ({ kind: 'agent', ts: 0, e });

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(o: { protocol?: number; result?: boolean; task?: boolean; bg?: boolean } = {}) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: (m) => (sent.push(m), true), close() {} }) });
  const dispatch = (e: ServerEvent) => act(() => void store.dispatch(serverEvent(e)));
  dispatch({ kind: 'hello', protocol: o.protocol ?? 8 });
  dispatch({ kind: 'session', id: 'S-1', root: '/r', title: null, model: null });
  dispatch(ev({ t: 'tool-call', id: 'toolu_A', name: 'Agent', input: { subagent_type: 'Explore', description: 'Look around' }, sub: false }));
  if (o.result) dispatch(ev({ t: 'tool-update', id: 'toolu_A', text: 'Async agent launched', isError: false }));
  if (o.task !== false) dispatch(ev({ t: 'task', id: 'ag1', phase: 'started', desc: 'Look around', type: 'local_agent', call: 'toolu_A', ...(o.bg !== undefined ? { bg: o.bg } : {}) }));
  render(<Provider store={store}><TooltipProvider><main data-chat-pane data-pane="chat"><div id="items"><Feed /></div></main></TooltipProvider></Provider>);
  return { sent, store, dispatch };
}
const menuBtn = () => document.querySelector<HTMLElement>('[data-agent-menu]');
const items = () => document.querySelector('[data-agent-menu-items]');

it('a running foreground subagent has a ⋯ menu with Stop and To background; Stop confirms then sends', () => {
  const { sent } = setup();
  fireEvent.click(menuBtn()!);
  const stop = items()!.querySelector<HTMLElement>('[data-task-stop]')!;
  fireEvent.click(stop);
  expect(stop).toHaveTextContent('Stop?');
  fireEvent.click(stop);
  expect(sent).toEqual([{ type: 'task-stop', id: 'ag1' }]);
});

it('To background sends the call id and closes the menu', () => {
  const { sent } = setup({ bg: false });
  fireEvent.click(menuBtn()!);
  fireEvent.click(items()!.querySelector('[data-task-background]')!);
  expect(sent).toEqual([{ type: 'task-background', toolUseId: 'toolu_A' }]);
  expect(items()).toBeNull();
});

it('an agent already in the background (the CLI says so, or its call has a result) offers Stop only', () => {
  setup({ result: true });
  fireEvent.click(menuBtn()!);
  expect(items()!.querySelector('[data-task-stop]')).not.toBeNull();
  expect(items()!.querySelector('[data-task-background]')).toBeNull();
});

it('no menu for a finished subagent, a call with no task, or a server older than protocol 8; Esc and an outside click close it', () => {
  setup({ task: false });
  expect(menuBtn()).toBeNull();
  cleanup();
  setup({ protocol: 7 });
  expect(menuBtn()).toBeNull();
  cleanup();
  const { dispatch } = setup();
  fireEvent.click(menuBtn()!);
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(items()).toBeNull();
  fireEvent.click(menuBtn()!);
  fireEvent.mouseDown(document.body);
  expect(items()).toBeNull();
  fireEvent.click(menuBtn()!);
  dispatch(ev({ t: 'task', id: 'ag1', phase: 'done' }));
  expect(menuBtn()).toBeNull();
});

it('the card of a stopped or failed background agent says so instead of done', () => {
  const { dispatch } = setup({ result: true });
  const status = () => document.querySelector('[data-agent-card]')?.getAttribute('data-status') ?? document.querySelector('[data-kind="agent-card"]')!.getAttribute('data-status');
  expect(status()).toBe('running');
  dispatch(ev({ t: 'task', id: 'ag1', phase: 'done', status: 'stopped' }));
  expect(status()).toBe('stopped');
});
it('the card of a failed one is an error', () => {
  const { dispatch } = setup({ result: true });
  dispatch(ev({ t: 'task', id: 'ag1', phase: 'done', status: 'failed' }));
  expect(document.querySelector('[data-kind="agent-card"]')!.getAttribute('data-status')).toBe('error');
});
