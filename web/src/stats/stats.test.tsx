import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ServerEvent, Stats } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { fmtK } from '@/lib/format.ts';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Meters, meterLevel } from './Meters.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => setLang('en'));
afterEach(cleanup);

function setup() {
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  const { container } = render(
    <Provider store={store}>
      <TooltipProvider><Meters /></TooltipProvider>
    </Provider>,
  );
  const stats = (s: Stats) => act(() => { store.dispatch(serverEvent({ kind: 'stats', stats: s } as ServerEvent)); });
  return { stats, container };
}
const none: Stats = { context: null, limits: null, cost: null };
const ctx = (pct: number) => ({ used: 50000, max: 200000, pct });

it('59 has no class, 60 warn, 85 hot', () => {
  expect(meterLevel(59)).toBe('');
  expect(meterLevel(60)).toBe('warn');
  expect(meterLevel(84.9)).toBe('warn');
  expect(meterLevel(85)).toBe('hot');
  const { stats } = setup();
  stats({ ...none, context: ctx(59) });
  expect(screen.getByRole('meter')).not.toHaveAttribute('data-level');
  stats({ ...none, context: ctx(60) });
  expect(screen.getByRole('meter')).toHaveClass('warn');
  stats({ ...none, context: ctx(85) });
  expect(screen.getByRole('meter')).toHaveClass('hot');
});

it('fmtK', () => {
  expect(fmtK(1234567)).toBe('1.2M');
  expect(fmtK(45678)).toBe('46k');
  expect(fmtK(999)).toBe('999');
});

it('meter has aria value and label', () => {
  const { stats } = setup();
  stats({ ...none, context: ctx(41.6) });
  const m = screen.getByRole('meter', { name: 'context 42%' });
  expect(m).toHaveAttribute('aria-valuenow', '42');
  expect(m).toHaveAttribute('aria-valuemin', '0');
  expect(m).toHaveAttribute('aria-valuemax', '100');
});

it('cost shows only without limits', () => {
  const { stats } = setup();
  stats({ ...none, cost: 1.234 });
  expect(screen.getByText('$1.23')).toBeInTheDocument();
  const lim = { utilization: 30, resets_at: null };
  stats({ ...none, cost: 1.234, limits: { five_hour: lim, seven_day: lim } });
  expect(screen.queryByText('$1.23')).toBeNull();
  expect(screen.getAllByRole('meter')).toHaveLength(2);
});

it('null stats and null parts render nothing', () => {
  const { stats, container } = setup();
  expect(container).toBeEmptyDOMElement();
  stats(none);
  expect(container).toBeEmptyDOMElement();
  stats({ ...none, limits: { five_hour: null, seven_day: { utilization: 10, resets_at: null } } });
  expect(screen.getAllByRole('meter')).toHaveLength(1);
  stats(none); // a new event replaces the slice
  expect(container).toBeEmptyDOMElement();
});

it('labels follow the language', () => {
  const { stats } = setup();
  stats({ ...none, context: ctx(10) });
  expect(screen.getByRole('meter')).toHaveAttribute('aria-label', 'context 10%');
  act(() => setLang('ru'));
  expect(screen.getByRole('meter')).toHaveAttribute('aria-label', 'контекст 10%');
});

it('the meters sit in the composer tools row, left of the compact and clear buttons (prototype footer)', async () => {
  const { Composer } = await import('@/composer/Composer.tsx');
  const store = makeStore({ url: 'ws://x', connect: () => ({ send: () => true, close() {} }) });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  act(() => { store.dispatch(serverEvent({ kind: 'stats', stats: { context: ctx(40), limits: null, cost: null } } as ServerEvent)); });
  const meter = screen.getByRole('meter');
  const compact = screen.getByRole('button', { name: /Compact context/ });
  const row = meter.closest('[data-tools-row]')!;
  expect(row).toContainElement(compact);
  expect(meter.compareDocumentPosition(compact) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
