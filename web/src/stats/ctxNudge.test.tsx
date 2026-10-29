import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { nudgeStep } from './CtxNudge.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => {
  setLang('en');
  localStorage.clear();
});
afterEach(cleanup);

function setup(id = 's1') {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  const connect = vi.fn((_u: unknown, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(
    <Provider store={store}>
      <TooltipProvider><Composer /></TooltipProvider>
    </Provider>,
  );
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  emit({ kind: 'hello', protocol: 5 }, { kind: 'session', id, root: '/r', title: null, model: null });
  const ctx = (pct: number) => emit({ kind: 'stats', stats: { context: { used: 1, max: 4, pct }, limits: null, cost: null } });
  const nudge = () => screen.queryByTestId('ctx-nudge');
  return { emit, ctx, nudge, commands: () => sent.filter((m) => m.type === 'command') };
}

it('steps: 0 below 25, then the highest of 25 / 50 / 75 reached', () => {
  expect([0, 24.9, 25, 49, 50, 74.9, 75, 99].map(nudgeStep)).toEqual([0, 0, 25, 25, 50, 50, 75, 75]);
});

it('shows from 25 %, says the step, and compacts on a click', async () => {
  const { ctx, nudge, commands } = setup();
  ctx(24);
  expect(nudge()).toBeNull();
  ctx(31);
  expect(nudge()).toHaveTextContent('Context 25% · compact');
  await userEvent.click(screen.getByRole('button', { name: 'Context 25% · compact' }));
  expect(commands()).toEqual([{ type: 'command', name: 'compact' }]);
});

it('hidden while the agent works', () => {
  const { emit, ctx, nudge } = setup();
  ctx(55);
  expect(nudge()).not.toBeNull();
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  expect(nudge()).toBeNull();
});

it('× hides it until the next step, across a reload of the same session', async () => {
  const { ctx, nudge } = setup();
  ctx(30);
  await userEvent.click(screen.getByRole('button', { name: 'Remind me at the next step' }));
  expect(nudge()).toBeNull();
  ctx(45);
  expect(nudge()).toBeNull();
  cleanup();
  const again = setup();
  again.ctx(45);
  expect(again.nudge()).toBeNull();
  again.ctx(50);
  expect(again.nudge()).toHaveTextContent('Context 50%');
});

it('a compaction lowers what was dismissed: the climb after it reminds again', async () => {
  const { ctx, nudge } = setup();
  ctx(60);
  await userEvent.click(screen.getByRole('button', { name: 'Remind me at the next step' }));
  ctx(8); // compacted
  ctx(27);
  expect(nudge()).toHaveTextContent('Context 25%');
});

it('dismissed per session: another session still reminds', async () => {
  const { ctx } = setup('a');
  ctx(30);
  await userEvent.click(screen.getByRole('button', { name: 'Remind me at the next step' }));
  cleanup();
  const b = setup('b');
  b.ctx(30);
  expect(b.nudge()).not.toBeNull();
});

it('?nudge shows it at any fill, with the real %; × hides it until a reload', async () => {
  history.replaceState(null, '', '/?nudge');
  try {
    const { ctx, nudge } = setup();
    ctx(12.4);
    expect(nudge()).toHaveTextContent('Context 12% · compact');
    await userEvent.click(screen.getByRole('button', { name: 'Remind me at the next step' }));
    expect(nudge()).toBeNull();
    cleanup();
    const again = setup();
    again.ctx(12.4);
    expect(again.nudge()).not.toBeNull();
  } finally {
    history.replaceState(null, '', '/');
  }
});
