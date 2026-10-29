import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment, ServerEvent, SubagentView } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { SelectionButton } from '@/comments/SelectionButton.tsx';
import { whereOf } from '@/comments/send.ts';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { activate, openAgent, restoreTabs, serializeTabs } from '@/tabs/slice.ts';
import { AgentView, POLL_MS } from './AgentView.tsx';

const SESSION = 'S-1';
const TOOL = 'toolu_A';
const rect = (left: number, top: number, w: number, h: number) =>
  ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON() {} }) as DOMRect;

const ev = (e: Extract<ServerEvent, { kind: 'agent' }>['e']): ServerEvent => ({ kind: 'agent', ts: 0, e });
const events = (n = 1): ServerEvent[] => [
  { kind: 'user', id: 'p1', text: 'Review the diff', historic: true, ts: 0 },
  ev({ t: 'message', id: 'a1:0', text: 'hello brave world' }),
  ev({ t: 'tool-call', id: 'toolu_in', name: 'Bash', input: { command: 'npm test' }, sub: false }),
  ev({ t: 'tool-update', id: 'toolu_in', text: 'FAIL src/a.test.ts', isError: false }),
  ...Array.from({ length: n - 1 }, (_, i): ServerEvent => ev({ t: 'message', id: `b${i}:0`, text: `more ${i}` })),
];
const view = (o: Partial<SubagentView> = {}): SubagentView => ({ events: events(), running: false, type: 'general-purpose', description: 'Re-review batch send', ...o });

let calls: string[];
let answer: () => Response;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

beforeEach(() => {
  localStorage.clear(); // tabs are saved per root: a test must not restore the last one's
  setLang('en');
  calls = [];
  answer = () => json(view());
  // only /subagent is under test; the root's other loads (/sources) get a plain 404
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/subagent') ? (calls.push(url), answer()) : new Response('', { status: 404 }))));
  Range.prototype.getBoundingClientRect = () => rect(10, 20, 40, 16);
  Range.prototype.getClientRects = () => [rect(10, 20, 40, 16)] as unknown as DOMRectList;
  Element.prototype.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  delete (Range.prototype as Partial<Range>).getClientRects;
});

function setup(o: { active?: boolean; protocol?: number } = {}) {
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: () => true, close() {} })) as never });
  act(() => {
    store.dispatch(serverEvent({ kind: 'hello', protocol: o.protocol ?? 7 }));
    store.dispatch(serverEvent({ kind: 'session', id: SESSION, root: '/r', title: null, model: null }));
    store.dispatch(openAgent({ tool: TOOL, title: 'saved title' }));
  });
  const tab = () => store.getState().tabs.open.find((t) => t.kind === 'agent')!;
  const ui = (active: boolean) => (
    <Provider store={store}>
      <TooltipProvider>
        <main data-chat-pane data-pane="chat" hidden />
        <AgentView tab={tab() as never} active={active} />
        <SelectionButton onComment={() => {}} />
      </TooltipProvider>
    </Provider>
  );
  const r = render(ui(o.active ?? true));
  return { store, r, rerender: (active: boolean) => r.rerender(ui(active)) };
}

const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('the subagent tab', () => {
  it('fetches the conversation of its Agent call for the current session and draws it with the chat feed', async () => {
    setup();
    expect(await screen.findByText('hello brave world')).toBeInTheDocument();
    expect(calls).toEqual([`/subagent?session=${SESSION}&tool=${TOOL}`]);
    expect(screen.getByText('Review the diff')).toBeInTheDocument();
    expect(screen.getByText('prompt')).toBeInTheDocument(); // the subagent's first message is a prompt, not "you"
    expect(screen.queryByText('you')).toBeNull();
  });

  it('has no composer and no input of any kind', async () => {
    const { r } = setup();
    await screen.findByText('hello brave world');
    expect(r.container.querySelector('textarea, input, [contenteditable="true"], form')).toBeNull();
  });

  it('is a commentable pane of its own: the chat pane markers plus its Agent call', async () => {
    const { r } = setup();
    await screen.findByText('hello brave world');
    const pane = r.container.querySelector('[data-pane="agent:toolu_A"]') as HTMLElement;
    expect(pane).toHaveAttribute('data-chat-pane');
    expect(pane.dataset.agent).toBe(TOOL);
    expect(pane.querySelector('[data-items] [data-item-id="a1:0"]')).not.toBeNull();
  });

  it('polls every 1.5 s while running and visible, and stops once the subagent has finished', async () => {
    vi.useFakeTimers();
    let n = 0;
    answer = () => json(view({ running: ++n < 3, events: events(n) }));
    setup();
    await flush(0);
    expect(calls).toHaveLength(1);
    await flush(POLL_MS);
    expect(calls).toHaveLength(2);
    await flush(POLL_MS); // this answer says finished
    expect(calls).toHaveLength(3);
    await flush(POLL_MS * 5);
    expect(calls).toHaveLength(3);
    expect(screen.getByText('more 1')).toBeInTheDocument();
  });

  it('stops polling when the call has its result and no task is live, even if the server still says running', async () => {
    vi.useFakeTimers();
    answer = () => json(view({ running: true }));
    const { store } = setup();
    act(() => {
      store.dispatch(serverEvent(ev({ t: 'tool-call', id: TOOL, name: 'Agent', input: {}, sub: false })));
      store.dispatch(serverEvent(ev({ t: 'tool-update', id: TOOL, text: 'agentId: a', isError: false })));
    });
    await flush(0);
    const n = calls.length;
    await flush(POLL_MS * 4);
    expect(calls.length).toBeLessThanOrEqual(n + 1); // at most the one read the change itself caused
    const after = calls.length;
    act(() => void store.dispatch(serverEvent(ev({ t: 'task', id: 'k', phase: 'started', desc: 'bg', type: 'local_agent', call: TOOL }))));
    await flush(POLL_MS * 3);
    expect(calls.length).toBeGreaterThan(after + 1); // a live task of the call: polled again
  });

  it('a failed read of a running agent is tried again with a backoff, not given up', async () => {
    vi.useFakeTimers();
    let n = 0;
    answer = () => (++n < 3 ? new Response('x', { status: 500 }) : json(view({ running: true })));
    setup();
    await flush(0);
    expect(calls).toHaveLength(1);
    await flush(3000);
    expect(calls).toHaveLength(2);
    await flush(6000);
    expect(calls).toHaveLength(3);
    expect(screen.getByText('hello brave world')).toBeInTheDocument();
  });

  it('does not poll while the tab is hidden, and reads again when it is shown', async () => {
    vi.useFakeTimers();
    answer = () => json(view({ running: true }));
    const { rerender } = setup();
    await flush(0);
    expect(calls).toHaveLength(1);
    rerender(false);
    await flush(POLL_MS * 4);
    expect(calls).toHaveLength(1); // has its content: a hidden tab is neither read nor polled
    rerender(true);
    await flush(0);
    expect(calls).toHaveLength(2);
    await flush(POLL_MS);
    expect(calls).toHaveLength(3);
  });

  it('a hidden tab with nothing yet reads once, so its comments can resolve', async () => {
    vi.useFakeTimers();
    answer = () => json(view({ running: true }));
    setup({ active: false });
    await flush(POLL_MS * 4);
    expect(calls).toHaveLength(1);
  });

  it('an identical refetch changes nothing (the entry object is kept)', async () => {
    vi.useFakeTimers();
    answer = () => json(view({ running: true }));
    const { store } = setup();
    await flush(0);
    const first = store.getState().subagents.byTool[TOOL];
    await flush(POLL_MS);
    expect(calls).toHaveLength(2);
    expect(store.getState().subagents.byTool[TOOL]).toBe(first);
  });

  it('says so when the subagent is not in this session (404 and 409), without a crash', async () => {
    answer = () => new Response('no', { status: 404 });
    const { r } = setup();
    expect(await screen.findByText('This subagent is not in the current session.')).toBeInTheDocument();
    r.unmount();
    answer = () => new Response('no', { status: 409 });
    setup();
    expect(await screen.findAllByText('This subagent is not in the current session.')).not.toHaveLength(0);
  });

  it('shows a failed read as a line, never a silent empty pane', async () => {
    answer = () => new Response('boom', { status: 500 });
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the subagent: HTTP 500');
  });

  it('a server older than protocol 7 (no /subagent: its page fallback answers HTML) asks for a server restart', async () => {
    answer = () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is older than this page: restart it (▾ → Restart the server)');
    cleanup();
    calls = [];
    setup({ protocol: 6 });
    expect(await screen.findByRole('alert')).toHaveTextContent('restart it');
    expect(calls).toEqual([]); // known old: not even asked
  });

  it('after a server restart to protocol 7 the tab reads at once', async () => {
    const { store } = setup({ protocol: 6 });
    expect(await screen.findByRole('alert')).toHaveTextContent('restart it');
    act(() => { store.dispatch(serverEvent({ kind: 'hello', protocol: 7 })); });
    expect(await screen.findByText('hello brave world')).toBeInTheDocument();
  });

  it('keeps the content when a later poll fails, and says so', async () => {
    vi.useFakeTimers();
    let n = 0;
    answer = () => (++n === 1 ? json(view({ running: true })) : new Response('x', { status: 500 }));
    setup();
    await flush(0);
    await flush(POLL_MS);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('hello brave world')).toBeInTheDocument();
  });

  it('names the tab by the real description once loaded', async () => {
    const { store } = setup();
    await screen.findByText('hello brave world');
    expect(store.getState().tabs.open.find((t) => t.kind === 'agent')).toMatchObject({ title: 'Re-review batch send' });
  });

  it('tabs persist: serialize, restore, and the restored tab refetches', async () => {
    const { store } = setup();
    await screen.findByText('hello brave world');
    const saved = serializeTabs(store.getState().tabs);
    expect(saved.tabs).toEqual([{ agent: { tool: TOOL, title: 'Re-review batch send' } }]);
    cleanup();
    calls.length = 0;
    const again = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, onState: (s: 'open') => void) => (onState('open'), { send: () => true, close() {} })) as never });
    act(() => {
      again.dispatch(serverEvent({ kind: 'session', id: SESSION, root: '/r', title: null, model: null }));
      again.dispatch(restoreTabs(saved));
    });
    expect(again.getState().tabs.open[1]).toMatchObject({ id: `agent:${TOOL}`, kind: 'agent', title: 'Re-review batch send' });
    render(
      <Provider store={again}><TooltipProvider><AgentView tab={again.getState().tabs.open[1] as never} active /></TooltipProvider></Provider>,
    );
    expect(await screen.findByText('hello brave world')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it('a session switch: the old entry is not shown, the tab reads again for the new session', async () => {
    const { store } = setup();
    await screen.findByText('hello brave world');
    answer = () => new Response('no', { status: 409 });
    act(() => void store.dispatch(serverEvent({ kind: 'session', id: 'S-2', root: '/r', title: null, model: null })));
    expect(await screen.findByText('This subagent is not in the current session.')).toBeInTheDocument();
    expect(calls.at(-1)).toBe(`/subagent?session=S-2&tool=${TOOL}`);
  });
});

describe('comments in the subagent tab', () => {
  async function select(r: ReturnType<typeof render>, textNodeOf: string, from: number, to: number) {
    const root = r.container.querySelector(`[data-item-id="${textNodeOf}"]`)!;
    const text = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      fireEvent.mouseUp(root);
      await new Promise((res) => setTimeout(res, 0));
    });
  }

  it('a selection in a reply becomes a comment whose anchor names the subagent; the batch line says so', async () => {
    const { store, r } = setup();
    await screen.findByText('hello brave world');
    await select(r, 'a1:0', 6, 11);
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    const c = store.getState().comments.items[0]!;
    expect(c.anchor.source).toEqual({ kind: 'message', id: 'a1:0', agent: TOOL });
    expect(c.anchor).toMatchObject({ quote: 'brave' });
    expect(whereOf(c, store.getState())).toBe('subagent reply «Re-review batch send»');
    setLang('ru');
    expect(whereOf(c, store.getState())).toBe('ответ субагента «Re-review batch send»');
  });

  it('a comment on an action of the subagent is named with the action and the subagent', async () => {
    const { store, r } = setup();
    await screen.findByText('hello brave world');
    fireEvent.click(screen.getByRole('button', { name: /Bash · npm test/ }));
    const pre = r.container.querySelector('[data-kind="tool-panel"] pre:nth-of-type(2)') ?? r.container.querySelectorAll('[data-kind="tool-panel"] pre')[1]!;
    const text = pre.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => {
      fireEvent.mouseUp(pre);
      await new Promise((res) => setTimeout(res, 0));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Looks good' }));
    const c = store.getState().comments.items[0]!;
    expect(c.anchor.source).toEqual({ kind: 'message', id: 'tool:toolu_in', agent: TOOL });
    expect(whereOf(c, store.getState())).toBe('Bash command (npm test) · subagent «Re-review batch send»');
  });

  it('the prompt the subagent was given is not commentable', async () => {
    const { r } = setup();
    await screen.findByText('hello brave world');
    await select(r, 'p1', 0, 6);
    expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
  });

  it('a server older than protocol 7 gets no comments here (it would file them under the main chat), and the pane says why', async () => {
    // such a server has no /subagent either: the pane asks for a restart and offers no comments
    const { r } = setup({ protocol: 6 });
    expect(await screen.findByRole('alert')).toHaveTextContent('restart it');
    expect(r.container.querySelector('[data-agent-nocomment]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Looks good' })).toBeNull();
  });

  it('the mark is drawn in the subagent pane for its comment, not in the chat', async () => {
    const { store, r } = setup();
    await screen.findByText('hello brave world');
    const c: Comment = {
      id: 'c1', text: 'why?', status: 'pending', createdAt: 1,
      anchor: { source: { kind: 'message', id: 'a1:0', agent: TOOL }, start: 6, end: 11, quote: 'brave', prefix: 'hello ', suffix: ' world' },
    };
    act(() => void store.dispatch(serverEvent({ kind: 'comments', items: [c] })));
    await vi.waitFor(() => expect(r.container.querySelectorAll('[data-hl-layer="agent:toolu_A"] [data-hl]').length).toBeGreaterThan(0));
  });

  it('the card of a comment on a subagent reply that is not loaded is an orphan, and one in a loaded reply is not', async () => {
    const { store } = setup();
    await screen.findByText('hello brave world');
    const { useCommentSource } = await import('@/comments/card/useCommentSource.ts');
    const { renderHook } = await import('@testing-library/react');
    const mk = (id: string, agent: string): Comment => ({
      id: 'c1', text: 'x', status: 'sent', createdAt: 1, sentIn: 'u',
      anchor: { source: { kind: 'message', id, agent }, start: 6, end: 11, quote: 'brave', prefix: 'hello ', suffix: ' world' },
    });
    const wrap = ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>;
    const ok = renderHook(() => useCommentSource(mk('a1:0', TOOL)), { wrapper: wrap });
    expect(ok.result.current.orphan).toBe(false);
    expect(ok.result.current.where).toBe('subagent reply «Re-review batch send»');
    const missing = renderHook(() => useCommentSource(mk('a1:0', 'toolu_other')), { wrapper: wrap });
    expect(missing.result.current.orphan).toBe(true);
    expect(missing.result.current.beforeCompact).toBe(false);
  });
});

describe('after a reload, with the tab closed or a poll failing', () => {
  it('the batch names the subagent by the Agent call in the chat, and an action by the chat\'s forwarded copy', () => {
    const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
    act(() => {
      store.dispatch(serverEvent({ kind: 'session', id: SESSION, root: '/r', title: null, model: null }));
      store.dispatch(serverEvent(ev({ t: 'tool-call', id: TOOL, name: 'Agent', input: { description: 'Re-review batch send' }, sub: false })));
      store.dispatch(serverEvent(ev({ t: 'tool-call', id: 'toolu_in', name: 'Bash', input: { command: 'npm test' }, sub: true })));
    });
    const c = (id: string): Comment => ({ id: 'c', text: 'x', status: 'pending', createdAt: 1, anchor: { source: { kind: 'message', id, agent: TOOL }, start: 0, end: 1, quote: 'a', prefix: '', suffix: '' } });
    expect(whereOf(c('a1:0'), store.getState())).toBe('subagent reply «Re-review batch send»');
    expect(whereOf(c('tool:toolu_in'), store.getState())).toBe('Bash command (npm test) · subagent «Re-review batch send»');
  });

  it('one failed poll leaves the comment card\'s source findable (no orphan flicker)', async () => {
    vi.useFakeTimers();
    let n = 0;
    answer = () => (++n === 1 ? json(view({ running: true })) : new Response('x', { status: 500 }));
    const { store } = setup();
    await flush(0);
    await flush(POLL_MS);
    const { itemsOf } = await import('./slice.ts');
    expect(store.getState().subagents.byTool[TOOL]!.status).toBe('error');
    expect(itemsOf(store.getState(), TOOL)?.length).toBeGreaterThan(0);
  });

  it('the main composer says its message goes to the main agent while an agent tab is active', async () => {
    const { store } = setup();
    const { Composer } = await import('@/composer/Composer.tsx');
    render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
    expect(document.querySelector('#composer-input')).toHaveAttribute('placeholder', 'Message the main agent… comments on the subagent’s replies go to it too');
    act(() => void store.dispatch(activate('chat')));
    expect(document.querySelector('#composer-input')).toHaveAttribute('placeholder', expect.stringMatching(/^Message the agent/));
  });
});

describe('Feed with an own feed', () => {
  it('draws the given feed, not the chat, and has no «earlier» button', async () => {
    const { store } = setup();
    await screen.findByText('hello brave world');
    const entry = store.getState().subagents.byTool[TOOL]!;
    const r = render(<Provider store={store}><Feed feed={entry.feed} agent={TOOL} /></Provider>);
    expect(r.container.querySelector('[data-earlier]')).toBeNull();
    expect(r.container.textContent).toContain('hello brave world');
  });
});
