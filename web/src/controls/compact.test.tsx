import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { Feed } from '@/feed/Feed.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  const connect = vi.fn((_u: string, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Feed />
        <Composer />
      </TooltipProvider>
    </Provider>,
  );
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  const commands = () => sent.filter((m) => m.type === 'command');
  return { sent, store, emit, commands };
}
const sdk = (m: Record<string, unknown>): ServerEvent => ({ kind: 'sdk', m: m as never, ts: Date.now() });
const sess = (id: string): ServerEvent => ({ kind: 'session', id, root: '/r', title: null, model: null });

it('Clear asks first and sends nothing until confirmed; Enter confirms', async () => {
  const { commands } = setup();
  const btn = screen.getByRole('button', { name: /Clear context/ });
  await userEvent.click(btn);
  expect(await screen.findByRole('dialog')).toHaveTextContent('Clear the context and start a new conversation?');
  expect(commands()).toEqual([]);
  await userEvent.keyboard('{Enter}');
  expect(commands()).toEqual([{ type: 'command', name: 'clear' }]);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Esc cancels the dialog with preventDefault and returns focus to the trigger', async () => {
  const { commands } = setup();
  const btn = screen.getByRole('button', { name: /Clear context/ });
  await userEvent.click(btn);
  await screen.findByRole('dialog');
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => void document.activeElement!.dispatchEvent(esc));
  expect(esc.defaultPrevented).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(commands()).toEqual([]);
  await waitFor(() => expect(btn).toHaveFocus());
});

it('Compact sends at once without asking', async () => {
  const { commands } = setup();
  await userEvent.click(screen.getByRole('button', { name: /Compact context/ }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(commands()).toEqual([{ type: 'command', name: 'compact' }]);
});

it('both buttons are disabled while busy', () => {
  const { emit } = setup();
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  expect(screen.getByRole('button', { name: /Compact context/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Clear context/ })).toBeDisabled();
});

it('a reset empties the feed and shows the cleared line; a boundary shows the compacted line', () => {
  const { emit } = setup();
  emit({ kind: 'user', id: 'u1', text: 'old message', ts: 1 });
  expect(screen.getByText(/old message/)).toBeInTheDocument();
  emit({ kind: 'replay', events: [] }, sdk({ type: 'conversation_reset' }));
  expect(screen.queryByText(/old message/)).toBeNull();
  expect(screen.getByText(/new conversation · context cleared/)).toBeInTheDocument();
  emit(sdk({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 12000 } }));
  expect(screen.getByText(/context compacted · was 12k tokens/)).toBeInTheDocument();
});

it('clearing with a pending chat comment ends with an empty panel, no re-push and no error', async () => {
  const { emit, store, sent } = setup();
  emit(sess('old'));
  const c = { id: 'c1', text: 'x', status: 'pending', createdAt: 1, anchor: { source: { kind: 'chat', messageId: 'm' }, quote: 'q' } } as never;
  emit({ kind: 'comments', items: [c] });
  expect(store.getState().comments.items).toHaveLength(1);
  // what the server does on /clear: a replay [], the live frame, the new session, then that session's (empty) set
  emit({ kind: 'replay', events: [] }, sdk({ type: 'conversation_reset' }), sess('new'), { kind: 'comments', items: [] });
  expect(store.getState().comments.items).toEqual([]);
  expect(sent.filter((m) => m.type === 'comments')).toEqual([]);
  expect(store.getState().feed.items.some((i) => i.kind === 'notice')).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('ConfirmDialog: Enter on the Cancel button cancels, not confirms', async () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ConfirmDialog title="T" body="B" confirm="Yes" cancel="No" onConfirm={onConfirm} onCancel={onCancel} />);
  screen.getByRole('button', { name: 'No' }).focus();
  await userEvent.keyboard('{Enter}');
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it('a Clear refused because the agent turned busy after the dialog opened shows the short note', async () => {
  const { emit, commands } = setup();
  await userEvent.click(screen.getByRole('button', { name: /Clear context/ }));
  await screen.findByRole('dialog');
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 }); // another window sent
  await userEvent.keyboard('{Enter}');
  expect(commands()).toEqual([]);
  expect(await screen.findByRole('status')).toHaveTextContent('Could not clear: agent is working…');
});
