import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent, WireAgentEvent } from '@nota-bene/shared';
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
const agent = (e: WireAgentEvent): ServerEvent => ({ kind: 'agent', e, ts: Date.now() });
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
  emit({ kind: 'replay', events: [] }, agent({ t: 'reset' }));
  expect(screen.queryByText(/old message/)).toBeNull();
  expect(screen.getByText(/new conversation · context cleared/)).toBeInTheDocument();
  emit(agent({ t: 'compacted', preTokens: 12000 }));
  expect(screen.getByText(/context compacted · was 12k tokens/)).toBeInTheDocument();
});

it('clearing with a pending chat comment ends with an empty panel, no re-push and no error', async () => {
  const { emit, store, sent } = setup();
  emit(sess('old'));
  const c = { id: 'c1', text: 'x', status: 'pending', createdAt: 1, anchor: { source: { kind: 'chat', messageId: 'm' }, quote: 'q' } } as never;
  emit({ kind: 'comments', items: [c] });
  expect(store.getState().comments.items).toHaveLength(1);
  // what the server does on /clear: a replay [], the live frame, the new session, then that session's (empty) set
  emit({ kind: 'replay', events: [] }, agent({ t: 'reset' }), sess('new'), { kind: 'comments', items: [] });
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

it.each([[/Compact context/], [/Clear context/]])('the tooltip of the disabled %s button still shows on hover (the span wrapper takes the pointer)', async (name) => {
  const { emit } = setup();
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  const btn = screen.getByRole('button', { name });
  expect(btn).toBeDisabled();
  expect(btn.parentElement!.tagName).toBe('SPAN');
  await userEvent.hover(btn.parentElement!);
  expect(await screen.findByRole('tooltip')).toBeInTheDocument();
});

it('compact and clear carry the prototype icons', () => {
  setup();
  const d = (name: RegExp) => [...screen.getByRole('button', { name }).querySelectorAll('path')].map((p) => p.getAttribute('d'));
  expect(d(/Compact context/)).toEqual(['M4 14h6v6', 'M20 10h-6V4', 'm14 10 7-7', 'm3 21 7-7']);
  expect(d(/Clear context/)).toEqual(['m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21', 'M22 21H7', 'm5 11 9 9']);
});

const idleState = (on: boolean, blocked = false): ServerEvent => ({ kind: 'idle-compact', state: { on, blocked, minutes: 50, awayMinutes: 15, minTokens: 200_000 } });

it('the idle-compaction toggle appears once the server tells its state, flips optimistically and sends it', async () => {
  const { sent, emit } = setup();
  expect(screen.queryByTestId('idle-compact')).toBeNull();
  emit(idleState(true));
  const btn = screen.getByTestId('idle-compact');
  expect(btn).toHaveAttribute('aria-pressed', 'true');
  expect(btn.getAttribute('aria-label')).toMatch(/Idle compaction: on.*50 min.*15 min.*200k/s);
  await userEvent.click(btn);
  expect(btn).toHaveAttribute('aria-pressed', 'false');
  expect(sent.filter((m) => m.type === 'idle-compact')).toEqual([{ type: 'idle-compact', on: false }]);
  emit(idleState(true)); // another window turned it back on: the echo wins
  expect(btn).toHaveAttribute('aria-pressed', 'true');
});

it('blocked by settings.json: the toggle is off, disabled and says why', () => {
  const { sent, emit } = setup();
  emit(idleState(true, true));
  const btn = screen.getByTestId('idle-compact');
  expect(btn).toBeDisabled();
  expect(btn).toHaveAttribute('aria-pressed', 'false');
  expect(btn.getAttribute('aria-label')).toMatch(/settings\.json/);
  expect(sent.filter((m) => m.type === 'idle-compact')).toEqual([]);
});

it("the server's idle /compact is a muted line, not the user's bubble", () => {
  const { emit } = setup();
  emit(idleState(true), { kind: 'user', id: 'i1', text: '/compact', ts: Date.now(), idle: true });
  expect(document.querySelector('[data-kind="user"]')).toBeNull();
  expect(document.querySelector('[data-kind="idle-compact"]')).toHaveTextContent(/⇣ idle compaction · 50 min after the turn/);
  emit(agent({ t: 'compacting' }));
  expect(document.querySelector('[data-kind="compacting"]')).not.toBeNull();
});
