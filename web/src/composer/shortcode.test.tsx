import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { loadEmoji } from '@/comments/emoji.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

// M6-05: the `:` emoji picker on the composer, next to the `@` picker, the suggestion Tab and the Shift+Tab mode cycle.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
beforeAll(() => loadEmoji());
beforeEach(() => { setLang('en'); vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  const connect = vi.fn((_u: string, onEvent: (e: ServerEvent) => void, onState: (s: 'open') => void) => {
    ev = onEvent;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const emit = (e: ServerEvent) => act(() => ev(e));
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  box.focus();
  return { sent, store, emit, box };
}

it('":smi" opens the list; Enter inserts the emoji through the draft and does not send', async () => {
  const { box, sent, store } = setup();
  await userEvent.keyboard('hi :smi');
  expect(await screen.findByRole('listbox')).toBeInTheDocument();
  await userEvent.keyboard('{Enter}');
  expect(box.value).toMatch(/^hi \p{Extended_Pictographic}/u);
  expect(store.getState().composer.draft).toBe(box.value);
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(sent.filter((m) => m.type === 'send')).toHaveLength(0);
});

it('Esc closes only the picker: the draft stays and a busy agent is not interrupted', async () => {
  const { box, sent, emit } = setup();
  emit({ kind: 'user', id: 'u1', text: 'go', ts: 1 } as ServerEvent); // busy
  await userEvent.keyboard(':smi');
  await screen.findByRole('listbox');
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box.value).toBe(':smi');
  expect(sent.filter((m) => m.type === 'interrupt')).toHaveLength(0);
});

it('Tab picks the emoji instead of taking the prompt suggestion', async () => {
  const { box, emit } = setup();
  emit({ kind: 'agent', ts: 1, e: { t: 'suggestion', text: 'run the tests' } });
  await userEvent.keyboard(':smi');
  await screen.findByRole('listbox');
  await userEvent.keyboard('{Tab}');
  expect(box.value).not.toBe('run the tests');
  expect(box.value).toMatch(/^\p{Extended_Pictographic}/u);
});

it('an open list takes Shift+Tab like the @ picker (no mode cycle); once closed it cycles again', async () => {
  const { sent, emit, box } = setup();
  emit({ kind: 'mode', mode: 'auto' } as ServerEvent);
  await userEvent.keyboard(':smi');
  await screen.findByRole('listbox');
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(sent.filter((m) => m.type === 'mode')).toEqual([]);
  expect(box.value).toMatch(/^\p{Extended_Pictographic}/u);
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(sent.filter((m) => m.type === 'mode')).toEqual([{ type: 'mode', mode: 'default' }]);
});

it('only one list at a time: ":smi" after "@a" shows the emoji list, "@a" alone shows the mention list', async () => {
  const { box } = setup();
  await userEvent.keyboard('@"a :smi');
  expect(await screen.findAllByRole('listbox')).toHaveLength(1);
  expect(screen.getAllByRole('option')[0].textContent).toMatch(/:smi/);
  await userEvent.clear(box);
  vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(['src/app.ts'])));
  await userEvent.keyboard('@a');
  expect(await screen.findAllByRole('listbox')).toHaveLength(1);
  expect(screen.getAllByRole('option')[0].textContent).toBe('app.tssrc/'); // name, then its folder
});

it('a `:` that is not at a word start (a path, a time) opens nothing', async () => {
  setup();
  await userEvent.keyboard('see a:smi and 12:30');
  expect(screen.queryByRole('listbox')).toBeNull();
});
