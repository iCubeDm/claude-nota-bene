import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup(open: boolean) {
  const sent: ClientMessage[] = [];
  let flip!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: string, _e: unknown, onState: (s: 'open' | 'closed') => void) => {
    flip = onState;
    if (open) onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Composer />
      </TooltipProvider>
    </Provider>,
  );
  return { sent, store, flip: (s: 'open' | 'closed') => act(() => flip(s)), box: screen.getByRole('textbox') as HTMLTextAreaElement };
}

it('Enter sends and clears', async () => {
  const { sent, box } = setup(true);
  await userEvent.type(box, 'hello{Enter}');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: 'send', text: 'hello', force: false });
  expect(box.value).toBe('');
  expect(box).toHaveFocus();
});

it('Shift+Enter adds a newline', async () => {
  const { sent, box } = setup(true);
  await userEvent.type(box, 'a{Shift>}{Enter}{/Shift}b');
  expect(box.value).toBe('a\nb');
  expect(sent).toHaveLength(0);
});

it('keeps text when send fails', async () => {
  const { sent, box } = setup(false);
  await userEvent.type(box, 'hello{Enter}');
  expect(sent).toHaveLength(0);
  expect(box.value).toBe('hello');
  expect(screen.getByText('no connection to the server…')).toBeVisible();
});

it('Stop is disabled when idle and Esc does nothing', async () => {
  const { sent, box } = setup(true);
  expect(screen.getByRole('button', { name: 'Stop the agent · Esc' })).toBeDisabled();
  await userEvent.type(box, '{Escape}');
  expect(sent).toHaveLength(0);
});

it('when busy: status shows, Esc interrupts, Ctrl+Enter forces', async () => {
  const { sent, store, box } = setup(true);
  act(() => {
    store.dispatch({ type: 'server/event', payload: { kind: 'user', id: 'u1', text: 'x', ts: 0 } });
  });
  expect(screen.getByText('agent is working…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop the agent · Esc' })).toBeEnabled();
  await userEvent.type(box, 'now{Control>}{Enter}{/Control}');
  expect(sent[0]).toMatchObject({ type: 'send', text: 'now', force: true });
  await userEvent.keyboard('{Escape}');
  expect(sent[1]).toEqual({ type: 'interrupt' });
});

it('offline label disappears when the socket reconnects, text stays', async () => {
  const { box, flip } = setup(false);
  await userEvent.type(box, 'hello{Enter}');
  expect(screen.getByText('no connection to the server…')).toBeVisible();
  flip('open');
  expect(screen.queryByText('no connection to the server…')).toBeNull();
  expect(box.value).toBe('hello');
});

it('Ctrl+Shift+Enter forces', async () => {
  const { sent, store, box } = setup(true);
  act(() => {
    store.dispatch({ type: 'server/event', payload: { kind: 'user', id: 'u1', text: 'x', ts: 0 } });
  });
  await userEvent.type(box, 'go{Control>}{Shift>}{Enter}{/Shift}{/Control}');
  expect(sent[0]).toMatchObject({ text: 'go', force: true });
});
