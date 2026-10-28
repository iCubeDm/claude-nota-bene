import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ModelOption, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { ModelPill } from './ModelPill.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => setLang('en'));
afterEach(cleanup);

const MODELS: ModelOption[] = [
  { value: 'sonnet', name: 'Sonnet 5', description: 'Everyday', resolved: 'claude-sonnet-5', efforts: ['low', 'medium', 'high'] },
  { value: 'opus', name: 'Opus 5', description: 'Hardest tasks', resolved: 'claude-opus-5', efforts: ['high', 'max'] },
  { value: 'haiku', name: 'Haiku 5', description: 'Fast', resolved: 'claude-haiku-5' },
];

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  const connect = vi.fn((_u: unknown, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(<Provider store={store}><TooltipProvider><ModelPill /></TooltipProvider></Provider>);
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  const ready = (used = 120_000) => emit(
    { kind: 'hello', protocol: 6 }, { kind: 'models', models: MODELS }, { kind: 'model', model: 'claude-sonnet-5', effort: 'medium' },
    { kind: 'stats', stats: { context: { used, max: 200_000, pct: 60 }, limits: null, cost: null } },
  );
  return { sent, emit, ready, store };
}
const pill = () => screen.getByRole('button', { name: /Model and effort/ });
const open = async () => { await userEvent.click(pill()); return screen.findByRole('menu'); };

it('renders nothing until a model or a list is known', () => {
  setup();
  expect(screen.queryByRole('button', { name: /Model and effort/ })).toBeNull();
});

it('shows the current model by its list name (the CLI reports the resolved id) and the effort', () => {
  const { ready } = setup();
  ready();
  expect(pill()).toHaveTextContent('Sonnet 5 · Medium');
});

it('without a list (an older server) it shows the reported name and is disabled', () => {
  const { emit } = setup();
  emit({ kind: 'hello', protocol: 5 }, { kind: 'session', id: null, root: '/p', title: null, model: 'claude-opus-5' });
  expect(pill()).toHaveTextContent('claude-opus-5');
  expect(pill()).toBeDisabled();
});

it('lists the models; effort levels only under a model that has them', async () => {
  const { ready } = setup();
  ready();
  const menu = await open();
  expect(within(menu).getByText('Sonnet 5')).toBeInTheDocument();
  expect(within(menu).getByText('Opus 5')).toBeInTheDocument();
  expect(within(menu).getByText('Haiku 5')).toBeInTheDocument();
  expect(within(within(menu).getByRole('group', { name: 'Sonnet 5' })).getAllByRole('menuitem').map((e) => e.textContent)).toContain('Medium');
  expect(within(within(menu).getByRole('group', { name: 'Opus 5' })).getByRole('group', { name: 'Effort' })).toBeInTheDocument();
  expect(within(within(menu).getByRole('group', { name: 'Haiku 5' })).queryByRole('group', { name: 'Effort' })).toBeNull();
});

it('picking another model sends it (keeping the effort when the model has it); the pill waits for the echo', async () => {
  const { sent, ready, emit } = setup();
  ready();
  const menu = await open();
  await userEvent.click(within(menu).getByText('Haiku 5'));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'haiku', id: expect.any(String) });
  expect(sent.at(-1)).not.toHaveProperty('effort');
  expect(pill()).toHaveTextContent('Sonnet 5');
  emit({ kind: 'model', model: 'haiku', ack: (sent.at(-1) as { id: string }).id });
  expect(pill()).toHaveTextContent(/^Haiku 5$/);
  const m2 = await open();
  await userEvent.click(within(m2).getByText('Sonnet 5'));
  expect(sent.at(-1)).toMatchObject({ model: 'sonnet' });
});

it('two rows resolving to one id (default and opus): only the alias in use is current, the other can still be picked', async () => {
  const { sent, emit } = setup();
  const twin: ModelOption[] = [{ value: 'default', name: 'Default', description: 'd', resolved: 'claude-opus-5' }, { value: 'opus', name: 'Opus 5', description: 'o', resolved: 'claude-opus-5' }];
  emit({ kind: 'hello', protocol: 6 }, { kind: 'models', models: twin }, { kind: 'model', model: 'claude-opus-5' });
  expect(pill()).toHaveTextContent(/^Default$/); // the CLI's default: the first row with that id
  const menu = await open();
  await userEvent.click(within(menu).getByText('Opus 5'));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'opus' });
});

it('picking an effort of the current model sends model + effort; the current choice sends nothing', async () => {
  const { sent, ready } = setup();
  ready();
  const menu = await open();
  const n = sent.length;
  await userEvent.click(within(within(menu).getByRole('group', { name: 'Sonnet 5' })).getByRole('menuitem', { name: 'Medium' }));
  expect(sent).toHaveLength(n);
  const m2 = await open();
  await userEvent.click(within(within(m2).getByRole('group', { name: 'Sonnet 5' })).getByRole('menuitem', { name: 'High' }));
  expect(sent.at(-1)).toMatchObject({ type: 'model', model: 'sonnet', effort: 'high' });
});

it('the cache warning: on another model with a non-empty context, in tokens/1000; never on the current model\'s own efforts', async () => {
  const { ready } = setup();
  ready(123_400);
  const menu = await open();
  const warns = within(menu).getAllByTestId('cache-warn');
  expect(warns).toHaveLength(2); // Opus and Haiku, not Sonnet (the current one)
  expect(warns[0]).toHaveTextContent('The next reply re-reads the context: ~123k tokens');
  expect(within(within(menu).getByRole('group', { name: 'Sonnet 5' })).queryByTestId('cache-warn')).toBeNull();
});

it('no warning with an empty context; the Russian text', async () => {
  const { ready } = setup();
  ready(0);
  let menu = await open();
  expect(within(menu).queryByTestId('cache-warn')).toBeNull();
  await userEvent.keyboard('{Escape}');
  act(() => setLang('ru'));
  ready(120_000);
  await userEvent.click(screen.getByRole('button', { name: /Модель и усилие/ }));
  menu = await screen.findByRole('menu');
  expect(within(menu).getAllByTestId('cache-warn')[0]).toHaveTextContent('Следующий ответ перечитает контекст: ~120 тыс. токенов');
});

it('is disabled and sends nothing for a server older than protocol 6', async () => {
  const { sent, emit } = setup();
  emit({ kind: 'hello', protocol: 5 }, { kind: 'models', models: MODELS }, { kind: 'model', model: 'sonnet' });
  expect(pill()).toBeDisabled(); // protocol 5: the server would not know the message
  expect(sent).toEqual([]);
});
