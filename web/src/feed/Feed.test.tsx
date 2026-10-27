import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Feed } from './Feed.tsx';
import { inputText } from './ToolLine.tsx';

beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup() {
  const sent: ClientMessage[] = [];
  const connect = vi.fn(() => ({ send: (m: ClientMessage) => (sent.push(m), true), close() {} }));
  const store = makeStore({ url: 'ws://x', connect });
  const view = render(
    <Provider store={store}>
      <Feed />
    </Provider>,
  );
  return { sent, store, view };
}

it('renders one element per feed item in order', () => {
  const { store, view } = setup();
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'hello', ts: 0, historic: true }));
    store.dispatch(
      serverEvent({
        kind: 'sdk',
        ts: 1,
        m: { type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'hi **there**' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } } as never,
      }),
    );
    store.dispatch(serverEvent({ kind: 'sdk', ts: 2, m: { type: 'result', subtype: 'success', duration_ms: 3000 } as never }));
  });
  const els = [...view.container.querySelectorAll('[data-kind]')];
  expect(els.map((e) => e.getAttribute('data-kind'))).toEqual(['user', 'assistant', 'tool', 'done']);
  expect(els[0]).toHaveAttribute('data-item-id', 'u1');
  expect(els[1]).toHaveAttribute('data-item-id', 'a:0');
  expect(els[2]).toHaveTextContent('▸ Bash · ls');
  expect(els[3]).toHaveTextContent(/^done · 3s/);
});

it('user meta shows "while working"', () => {
  const { store, view } = setup();
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'first', ts: Date.now() }));
    store.dispatch(serverEvent({ kind: 'user', id: 'u2', text: 'second', ts: Date.now() }));
  });
  const [first, second] = [...view.container.querySelectorAll('[data-kind="user"]')];
  expect(first!.firstElementChild!.textContent).toMatch(/^you · \d/);
  expect(first!.firstElementChild!.textContent).not.toContain('while working');
  expect(second!.firstElementChild!.textContent).toContain(' · while working');
});

it('permission buttons dispatch answerPermission and the card shows the answer', () => {
  const { store, sent } = setup();
  act(() => {
    store.dispatch(serverEvent({ kind: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'rm -rf x' }, ts: 1 }));
  });
  expect(screen.getByText('Allow Bash?')).toBeInTheDocument();
  expect(screen.getByText('rm -rf x').tagName).toBe('PRE');
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  expect(sent).toContainEqual({ type: 'permission', id: 'p1', allow: true });
  act(() => {
    store.dispatch(serverEvent({ kind: 'permission-done', id: 'p1', allow: true, ts: 2 }));
  });
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('✓ allowed')).toBeInTheDocument();
});

it('an empty chat shows a prompt to start, gone after the first message', () => {
  const { store, view } = setup();
  expect(view.container.querySelector('[data-kind="empty"]')).toHaveTextContent('Write to the agent to get started');
  act(() => { store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'hi', ts: 1 })); });
  expect(view.container.querySelector('[data-kind="empty"]')).toBeNull();
});

function toolFeed(command: string, output: unknown, isError = false) {
  const h = setup();
  act(() => {
    h.store.dispatch(serverEvent({ kind: 'sdk', ts: 1, m: { type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command, description: 'd' } }] } } as never }));
    if (output !== undefined) {
      h.store.dispatch(serverEvent({ kind: 'sdk', ts: 2, m: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: output, ...(isError ? { is_error: true } : {}) }] } } as never }));
    }
  });
  return h;
}

it('clicking the line shows the full command and the output', () => {
  const { view } = toolFeed('ls -la\necho second-line', 'file-a\nfile-b');
  const btn = screen.getByRole('button', { name: /Bash/ });
  expect(btn).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByTestId('tool-panel')).toBeNull();
  fireEvent.click(btn);
  expect(btn).toHaveAttribute('aria-expanded', 'true');
  const panel = screen.getByTestId('tool-panel');
  expect(panel).toHaveAttribute('data-anchor-skip');
  expect(panel).toHaveTextContent('ls -la');
  expect(panel).toHaveTextContent('echo second-line');
  expect(panel).toHaveTextContent('file-a');
  expect(view.container.querySelector('[data-anchor-skip] pre')).not.toBeNull();
  fireEvent.click(btn);
  expect(screen.queryByTestId('tool-panel')).toBeNull();
});

it('a tool without a result shows the running hint while busy and "no output" otherwise', () => {
  const { store } = toolFeed('sleep 9', undefined);
  fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
  expect(screen.getByText('no output')).toBeInTheDocument();
  act(() => {
    store.dispatch(serverEvent({ kind: 'user', id: 'u9', text: 'go', ts: 3 }));
  });
  expect(screen.getByText('running…')).toBeInTheDocument();
});

it('an empty result shows "no output"; the toggle is wired to its panel', () => {
  toolFeed('true', '');
  const btn = screen.getByRole('button', { name: /Bash/ });
  fireEvent.click(btn);
  expect(screen.getByText('no output')).toBeInTheDocument();
  expect(btn).toHaveAttribute('aria-controls', screen.getByTestId('tool-panel').id);
});

it('inputText prints string fields raw with the main argument first', () => {
  expect(inputText('Task', { subagent_type: 'x', prompt: 'a\nb', opts: { n: 1 } })).toBe('prompt:\na\nb\n\nsubagent_type:\nx\n\nopts:\n{\n  "n": 1\n}');
  expect(inputText('Bash', { command: 'ls', description: 'd' })).toBe('ls');
});

it('error output is red', () => {
  toolFeed('false', 'boom', true);
  fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
  expect(screen.getByText('boom')).toHaveClass('text-destructive');
});

it('renders only the first 20000 characters of a long output until show all', () => {
  toolFeed('big', 'x'.repeat(20_000) + 'TAIL');
  fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
  expect(screen.getByTestId('tool-panel')).not.toHaveTextContent('TAIL');
  fireEvent.click(screen.getByRole('button', { name: 'show all' }));
  expect(screen.getByTestId('tool-panel')).toHaveTextContent('TAIL');
  expect(screen.queryByRole('button', { name: 'show all' })).toBeNull();
});

it('a server error is not a chat item (it is a toast)', () => {
  const { store, view } = setup();
  act(() => void store.dispatch(serverEvent({ kind: 'server-error', where: 'ws', message: 'boom' })));
  expect(view.container.querySelector('[data-kind="notice"]')).toBeNull();
});

it('scrolled up: a "jump to the latest" button appears, marks new items, and scrolls to the end', () => {
  const store = makeStore({ url: 'ws://x', connect: vi.fn(() => ({ send: () => true, close() {} })) });
  render(
    <Provider store={store}>
      <main data-chat-pane>
        <Feed />
      </main>
    </Provider>,
  );
  const pane = document.querySelector<HTMLElement>('[data-chat-pane]')!;
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 5000 });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
  const scrollTo = vi.fn();
  pane.scrollTo = scrollTo as never;
  expect(screen.queryByRole('button', { name: 'Jump to the latest' })).toBeNull();
  pane.scrollTop = 1000; // far from the end
  fireEvent.scroll(pane);
  const btn = screen.getByRole('button', { name: 'Jump to the latest' });
  expect(btn.dataset.unread).toBeUndefined();
  act(() => { store.dispatch(serverEvent({ kind: 'sdk', ts: 1, m: { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'new' }] } } } as never)); });
  expect(btn.dataset.unread).toBe('true'); // something new below while away
  fireEvent.click(btn);
  expect(scrollTo).toHaveBeenCalledWith({ top: 5000, behavior: 'smooth' });
  pane.scrollTop = 4400; // arrived at the end
  fireEvent.scroll(pane);
  expect(screen.queryByRole('button', { name: 'Jump to the latest' })).toBeNull();
});

describe('action groups', () => {
  const tool = (id: string, name: string, cmd: string) => ({ type: 'tool_use', id, name, input: { command: cmd } });
  const result = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: 'out', is_error: isError });
  function run(store: ReturnType<typeof makeStore>, n: number, o: { errors?: number; end?: boolean } = {}) {
    act(() => {
      store.dispatch(serverEvent({ kind: 'user', id: 'u1', text: 'go', ts: 0 } as never));
      for (let i = 1; i <= n; i++) {
        store.dispatch(serverEvent({ kind: 'sdk', ts: i, m: { type: 'assistant', uuid: `a${i}`, message: { content: [tool(`t${i}`, 'Bash', `cmd-${i}`)] } } as never }));
        store.dispatch(serverEvent({ kind: 'sdk', ts: i, m: { type: 'user', message: { content: [result(`t${i}`, i <= (o.errors ?? 0))] } } as never }));
      }
      if (o.end) store.dispatch(serverEvent({ kind: 'sdk', ts: 99, m: { type: 'result', subtype: 'success', duration_ms: 1000, user_message_uuids: ['u1'] } as never }));
    });
  }

  it('a single action stays a plain line', () => {
    const { store, view } = setup();
    run(store, 1, { end: true });
    expect(view.container.querySelector('[data-kind="tool-group"]')).toBeNull();
    expect(screen.getByRole('button', { name: /Bash · cmd-1/ })).toBeInTheDocument();
  });

  it('consecutive actions fold into "N actions", collapsed; a click shows every line, each still expandable', () => {
    const { store, view } = setup();
    run(store, 3, { end: true });
    const group = view.container.querySelector('[data-kind="tool-group"]')!;
    const head = screen.getByRole('button', { name: '3 actions' });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(group.querySelectorAll('[data-kind="tool"]')).toHaveLength(0); // done: nothing below the head
    fireEvent.click(head);
    expect(group.querySelectorAll('[data-kind="tool"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Bash · cmd-2/ }));
    expect(screen.getByTestId('tool-panel')).toHaveTextContent('cmd-2');
  });

  it('while the turn runs, the last action shows under the head', () => {
    const { store, view } = setup();
    run(store, 2);
    const group = view.container.querySelector('[data-kind="tool-group"]')!;
    const shown = [...group.querySelectorAll('[data-kind="tool"]')];
    expect(shown).toHaveLength(1);
    expect(shown[0]).toHaveTextContent('Bash · cmd-2');
  });

  it('errors are counted on the head in red, the group stays collapsed', () => {
    setLang('ru');
    const { store } = setup();
    run(store, 5, { errors: 2, end: true });
    const head = screen.getByRole('button', { name: /^5 действий/ });
    expect(head).toHaveTextContent('5 действий · 2 ошибки');
    expect(head.querySelector('.text-destructive')).toHaveTextContent('2 ошибки');
    expect(head).toHaveAttribute('aria-expanded', 'false');
  });
});
