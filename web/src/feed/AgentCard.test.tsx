import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { HighlightLayer } from '@/comments/HighlightLayer.tsx';
import { useCommentSource } from '@/comments/card/useCommentSource.ts';
import { renderHook } from '@testing-library/react';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { AgentView } from '@/subagent/AgentView.tsx';
import { Feed } from './Feed.tsx';

const ev = (e: Extract<ServerEvent, { kind: 'agent' }>['e']): ServerEvent => ({ kind: 'agent', ts: 0, e });
const call = (id: string, name: string, input: Record<string, unknown>) => ev({ t: 'tool-call', id, name, input, sub: false });
const result = (id: string, text: string, isError = false) => ev({ t: 'tool-update', id, text, isError });

beforeEach(() => {
  localStorage.clear(); // tabs are saved per root: a test must not restore the last one's
  setLang('en');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/subagent') ? new Response(JSON.stringify({
    events: [{ kind: 'agent', ts: 0, e: { t: 'message', id: 'a1:0', text: 'the subagent says hi' } }],
    running: false, type: 'Explore', description: 'Look around',
  })) : new Response('', { status: 404 }))));
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(events: ServerEvent[]) {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: () => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'hello', protocol: 7 }));
    store.dispatch(serverEvent({ kind: 'session', id: 'S-1', root: '/r', title: null, model: null }));
    for (const e of events) store.dispatch(serverEvent(e));
  });
  render(<Provider store={store}><TooltipProvider><main data-chat-pane data-pane="chat"><div id="items"><Feed /></div></main></TooltipProvider></Provider>);
  return store;
}

describe('the Agent call as a card', () => {
  it('shows the type, the description, the status and an open button; the call has no plain tool line', () => {
    setup([call('t1', 'Agent', { subagent_type: 'Explore', description: 'Look around', prompt: 'p' }), result('t1', 'agentId: a1')]);
    const card = document.querySelector('[data-kind="agent-card"]') as HTMLElement;
    expect(card).toHaveTextContent('Explore');
    expect(card).toHaveTextContent('Look around');
    expect(card.dataset.status).toBe('done');
    expect(screen.getByRole('button', { name: 'open' })).toBeInTheDocument();
    expect(screen.queryByText(/Agent · /)).toBeNull();
  });

  it('the older tool name Task is a card too', () => {
    setup([call('t1', 'Task', { subagent_type: 'general-purpose', description: 'Old style' }), result('t1', 'ok')]);
    expect(document.querySelector('[data-kind="agent-card"]')).toHaveTextContent('Old style');
  });

  it('status: running without a result while the turn runs, error from an error result, done otherwise', () => {
    setup([
      { kind: 'user', id: 'u1', text: 'go', ts: 1 },
      call('t1', 'Agent', { description: 'one' }), call('t2', 'Agent', { description: 'two' }), result('t2', 'boom', true),
      call('t3', 'Agent', { description: 'three' }), result('t3', 'fine'),
    ]);
    const status = (d: string) => [...document.querySelectorAll<HTMLElement>('[data-kind="agent-card"]')].find((c) => c.textContent?.includes(d))!.dataset.status;
    expect([status('one'), status('two'), status('three')]).toEqual(['running', 'error', 'done']);
  });

  it('a call with no result in a feed that is not working is stopped, not running forever', () => {
    setup([call('t1', 'Agent', { description: 'one' })]);
    expect((document.querySelector('[data-kind="agent-card"]') as HTMLElement).dataset.status).toBe('stopped');
  });

  it('the open button opens the agent tab (once, titled by the description) and activates it', () => {
    const store = setup([call('t1', 'Agent', { subagent_type: 'Explore', description: 'Look around' }), result('t1', 'ok')]);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const { open, active } = store.getState().tabs;
    expect(open.filter((t) => t.kind === 'agent')).toEqual([{ id: 'agent:t1', kind: 'agent', tool: 't1', title: 'Look around' }]);
    expect(active).toBe('agent:t1');
  });

  it('a call is never folded into a run of actions; the actions around it still fold', () => {
    setup([
      call('b1', 'Bash', { command: 'a' }), result('b1', 'x'), call('b2', 'Bash', { command: 'b' }), result('b2', 'x'),
      call('t1', 'Agent', { description: 'Look around' }), result('t1', 'ok'),
      call('b3', 'Bash', { command: 'c' }), result('b3', 'x'),
    ]);
    expect(screen.getByRole('button', { name: /2 actions/ })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-kind="agent-card"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Bash · c/ })).toBeInTheDocument();
  });

  it('the chevron still opens the call\'s own input and output (commentable like any action)', () => {
    setup([call('t1', 'Agent', { description: 'Look around', prompt: 'find the bug' }), result('t1', 'the report')]);
    fireEvent.click(screen.getByRole('button', { name: /Look around/ }));
    expect(screen.getByTestId('tool-panel')).toHaveTextContent('find the bug');
    expect(screen.getByTestId('tool-panel')).toHaveTextContent('the report');
  });

  it('a nested Agent call inside a subagent\'s tab opens the same way', async () => {
    const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: () => true, close() {} })) as never });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/subagent') ? new Response(JSON.stringify({
      events: [call('toolu_nested', 'Agent', { subagent_type: 'Explore', description: 'Nested one' }), result('toolu_nested', 'ok')],
      running: false, type: 'general-purpose', description: 'Outer',
    })) : new Response('', { status: 404 }))));
    act(() => void store.dispatch(serverEvent({ kind: 'session', id: 'S-1', root: '/r', title: null, model: null })));
    render(<Provider store={store}><TooltipProvider><AgentView tab={{ id: 'agent:toolu_outer', kind: 'agent', tool: 'toolu_outer', title: 'Outer' }} active /></TooltipProvider></Provider>);
    fireEvent.click(await screen.findByRole('button', { name: 'open' }));
    expect(store.getState().tabs.active).toBe('agent:toolu_nested');
  });
});

describe('jump to a subagent comment', () => {
  const c: Comment = {
    id: 'c1', text: 'why', status: 'sent', createdAt: 1, sentIn: 'u',
    anchor: { source: { kind: 'message', id: 'a1:0', agent: 't1' }, start: 4, end: 12, quote: 'subagent', prefix: 'the ', suffix: ' says hi' },
  };

  it('opens the agent tab, reads the conversation and scrolls to the fragment', async () => {
    const store = setup([call('t1', 'Agent', { subagent_type: 'Explore', description: 'Look around' }), result('t1', 'ok')]);
    // the tab's pane, next to the chat, as Panes mounts it
    const view = render(<Provider store={store}><TooltipProvider><PaneFor store={store} /></TooltipProvider></Provider>);
    void view;
    const hook = renderHook(() => useCommentSource(c), { wrapper: ({ children }) => <Provider store={store}>{children}</Provider> });
    expect(hook.result.current.orphan).toBe(true); // nothing loaded yet: orphaned, not dropped
    const scrolled = vi.fn();
    Element.prototype.scrollTo = scrolled;
    Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 5, bottom: 5, width: 5, height: 5, x: 0, y: 0, toJSON() {} }) as DOMRect;
    act(() => hook.result.current.jump());
    expect(store.getState().tabs.active).toBe('agent:t1');
    await vi.waitFor(() => expect(scrolled).toHaveBeenCalled());
    await vi.waitFor(() => expect(hook.result.current.orphan).toBe(false));
    expect(hook.result.current.where).toBe('subagent reply «Look around»');
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  });
});

function PaneFor({ store }: { store: ReturnType<typeof makeStore> }) {
  // mounts the pane of every agent tab the store opens (a tiny Panes)
  const [, force] = useReducerTick();
  store.subscribe(force);
  return <>{store.getState().tabs.open.map((t) => (t.kind === 'agent' ? <div key={t.id}><AgentView tab={t} active={store.getState().tabs.active === t.id} /><HighlightLayer pane={t.id} /></div> : null))}</>;
}
import { useReducer } from 'react';
const useReducerTick = () => useReducer((n: number) => n + 1, 0);
