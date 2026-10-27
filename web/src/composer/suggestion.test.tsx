import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent, WireAgentEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
beforeEach(() => setLang('en'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  let ev!: (e: ServerEvent) => void;
  const connect = vi.fn((_u: string, onEvent: (e: ServerEvent) => void, onState: (s: 'open') => void) => {
    ev = onEvent;
    onState('open');
    return { send: (_m: ClientMessage) => true, close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const emit = (e: ServerEvent) => act(() => ev(e));
  const agent = (e: WireAgentEvent) => emit({ kind: 'agent', ts: 1, e });
  const suggest = (s: string) => agent({ t: 'suggestion', text: s });
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  return { store, emit, agent, suggest, box };
}
const user = (historic = false): ServerEvent => ({ kind: 'user', id: 'u1', text: 'hi', ts: 1, ...(historic ? { historic: true } : {}) }) as ServerEvent;

it('shows the suggestion as the placeholder with a badge when idle, hides it when busy', () => {
  const { suggest, emit, box } = setup();
  suggest('run the tests');
  expect(box.placeholder).toBe('run the tests');
  expect(screen.getByText('Tab ⇥')).toHaveAttribute('aria-hidden', 'true');
  emit(user()); // a send makes the agent busy (and clears the suggestion)
  expect(box.placeholder).not.toBe('run the tests');
  suggest('run the tests'); // arrives while busy: stored but not shown
  expect(box.placeholder).not.toBe('run the tests');
  expect(screen.queryByText('Tab ⇥')).toBeNull();
});

it('hides it when the field has text', async () => {
  const { suggest, box } = setup();
  suggest('run the tests');
  await userEvent.type(box, 'x');
  expect(box.placeholder).not.toBe('run the tests');
  expect(screen.queryByText('Tab ⇥')).toBeNull();
});

it('Tab fills the field through the draft, caret at the end, and keeps focus', async () => {
  const { suggest, box, store } = setup();
  suggest('run the tests');
  box.focus();
  await userEvent.keyboard('{Tab}');
  expect(box.value).toBe('run the tests');
  expect(store.getState().composer.draft).toBe('run the tests');
  expect(box).toHaveFocus();
  await vi.waitFor(() => expect(box.selectionStart).toBe(13));
});

it('Tab does nothing special without a suggestion, with text, or with Shift', async () => {
  const { suggest, box, store } = setup();
  box.focus();
  await userEvent.keyboard('{Tab}');
  expect(store.getState().composer.draft).toBe('');
  suggest('go');
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(store.getState().composer.draft).toBe('');
});

it('Tab with the @ picker open picks from the picker, not the suggestion', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ['src/app.ts'] })));
  const { suggest, box } = setup();
  suggest('run the tests');
  box.focus();
  fireEvent.change(box, { target: { value: '@ap' } });
  box.setSelectionRange(3, 3);
  fireEvent.input(box);
  await screen.findByRole('listbox');
  fireEvent.keyDown(box, { key: 'Tab' });
  expect(box.value).toContain('src/app.ts');
  expect(box.value).not.toContain('run the tests');
});

it.each([
  ['a live user event', user()],
  ['a replayed user event', user(true)],
  ['a replay', { kind: 'replay', events: [] } as unknown as ServerEvent],
])('%s clears it', (_n, e) => {
  const { suggest, emit, store } = setup();
  suggest('run the tests');
  emit(e);
  expect(store.getState().controls.suggestion).toBe('');
});

it('a reset (/clear) clears it', () => {
  const { suggest, agent, store } = setup();
  suggest('run the tests');
  agent({ t: 'reset' });
  expect(store.getState().controls.suggestion).toBe('');
});

it('is hidden while a switch is in flight', () => {
  const { suggest, store, box } = setup();
  suggest('run the tests');
  act(() => void store.dispatch({ type: 'controls/switchStarted' }));
  expect(box.placeholder).not.toBe('run the tests');
});

it('a session re-announce with the same id (title refresh) keeps it; a different id or root clears it', () => {
  const { suggest, emit, store } = setup();
  const session = (id: string, root = '/r', title = 'T') => ({ kind: 'session', id, root, title }) as unknown as ServerEvent;
  emit(session('s1'));
  suggest('run the tests');
  emit(session('s1', '/r', 'new title'));
  expect(store.getState().controls.suggestion).toBe('run the tests');
  emit(session('s1', '/other'));
  expect(store.getState().controls.suggestion).toBe('');
  suggest('again');
  emit(session('s2', '/other'));
  expect(store.getState().controls.suggestion).toBe('');
});
