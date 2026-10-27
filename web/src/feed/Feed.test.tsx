import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
    store.dispatch(serverEvent({ kind: 'agent', ts: 1, e: { t: 'message', id: 'a:0', text: 'hi **there**' } }));
    store.dispatch(serverEvent({ kind: 'agent', ts: 1, e: { t: 'tool-call', id: 't1', name: 'Bash', input: { command: 'ls' }, sub: false } }));
    store.dispatch(serverEvent({ kind: 'agent', ts: 2, e: { t: 'turn-end', stop: 'done', secs: 3, answers: 'none', queued: 0 } }));
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

function toolFeed(command: string, output: string | undefined, isError = false) {
  const h = setup();
  act(() => {
    h.store.dispatch(serverEvent({ kind: 'agent', ts: 1, e: { t: 'tool-call', id: 't1', name: 'Bash', input: { command, description: 'd' }, sub: false } }));
    if (output !== undefined) {
      h.store.dispatch(serverEvent({ kind: 'agent', ts: 2, e: { t: 'tool-update', id: 't1', text: output, isError } }));
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
