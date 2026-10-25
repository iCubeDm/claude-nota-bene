import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Feed } from './Feed.tsx';

beforeEach(() => setLang('en'));

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
