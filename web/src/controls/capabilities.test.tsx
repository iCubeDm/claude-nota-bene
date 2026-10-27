import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_CAPABILITIES, type Capabilities, type ClientMessage, type ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { nextMode } from './slice.ts';

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
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  const hello = (capabilities?: Partial<Capabilities>) =>
    emit({ kind: 'hello', protocol: 5, ...(capabilities ? { capabilities: { ...CLAUDE_CAPABILITIES, ...capabilities } } : {}) });
  const idle = { kind: 'idle-compact', state: { on: true, blocked: false, minutes: 5, awayMinutes: 5, minTokens: 1000 } } as const;
  const stats = { kind: 'stats', stats: { context: { used: 100, max: 1000, pct: 10 }, limits: null, cost: null } } as const;
  return { sent, store, emit, hello, idle, stats };
}

it('before hello the gated controls (pill, meters, idle toggle) are hidden: they do not flash', () => {
  const { emit, idle, stats, hello } = setup();
  emit({ kind: 'mode', mode: 'default' }, idle, stats);
  expect(screen.queryByRole('button', { name: /Agent mode/ })).toBeNull();
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.queryByTestId('idle-compact')).toBeNull();
  hello();
  expect(screen.getByRole('button', { name: /Agent mode/ })).toBeInTheDocument();
});

it('a hello without capabilities (an older server) leaves every control: the web assumes Claude\'s set', () => {
  const { emit, hello, idle, stats, store } = setup();
  emit({ kind: 'mode', mode: 'default' }, idle, stats);
  hello();
  expect(store.getState().controls.capabilities).toEqual(CLAUDE_CAPABILITIES);
  expect(screen.getByRole('button', { name: /Agent mode/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Compact context/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Clear context/ })).toBeInTheDocument();
  expect(screen.getByTestId('idle-compact')).toBeInTheDocument();
  expect(screen.getByRole('meter')).toBeInTheDocument();
});

it('compact:false hides Compact and the idle toggle; modes:[default] hides the pill; Shift+Tab sends nothing', async () => {
  const { sent, emit, hello, idle } = setup();
  emit({ kind: 'mode', mode: 'default' }, idle);
  hello({ compact: false, modes: ['default'] });
  expect(screen.queryByRole('button', { name: /Compact context/ })).toBeNull();
  expect(screen.queryByTestId('idle-compact')).toBeNull();
  expect(screen.queryByRole('button', { name: /Agent mode/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Clear context/ })).toBeInTheDocument();
  screen.getByRole('textbox').focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(sent.filter((m) => m.type === 'mode')).toEqual([]);
});

it('clear:false hides Clear; idleCompact:false hides only the idle toggle; usage:false hides the meters', () => {
  const { emit, hello, idle, stats } = setup();
  emit({ kind: 'mode', mode: 'default' }, idle, stats);
  hello({ clear: false, idleCompact: false, usage: false });
  expect(screen.queryByRole('button', { name: /Clear context/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Compact context/ })).toBeInTheDocument();
  expect(screen.queryByTestId('idle-compact')).toBeNull();
  expect(screen.queryByRole('meter')).toBeNull();
});

it('the pill menu offers only the agent\'s modes, and Shift+Tab cycles through them', async () => {
  const { sent, emit, hello } = setup();
  emit({ kind: 'mode', mode: 'default' });
  hello({ modes: ['default', 'plan'] });
  await userEvent.click(screen.getByRole('button', { name: /Agent mode/ }));
  expect(await screen.findByText('Plan')).toBeInTheDocument();
  expect(screen.queryByText('Auto')).toBeNull();
  await userEvent.keyboard('{Escape}');
  screen.getByRole('textbox').focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(sent.filter((m) => m.type === 'mode')).toMatchObject([{ mode: 'plan' }]);
});

it('nextMode skips the modes the agent lacks and wraps; a mode outside the list goes to its first', () => {
  expect(nextMode('plan', ['default', 'plan'])).toBe('default');
  expect(nextMode('default', ['default', 'plan'])).toBe('plan');
  expect(nextMode('auto', ['default', 'plan'])).toBe('default');
});
