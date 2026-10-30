import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ClientMessage, SlashCommand } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentPopup } from '@/comments/CommentPopup.tsx';
import type { PendingSelection } from '@/comments/SelectionButton.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore, serverEvent } from '@/store/store.ts';
import { Composer } from './Composer.tsx';

beforeEach(() => setLang('en'));
afterEach(cleanup);

const LIST: SlashCommand[] = [
  { name: 'ping', description: 'Reply PONG' },
  { name: 'hello', description: 'Say hello', hint: '[name]' },
  { name: 'compact', description: 'Free up context', builtin: true },
];

function setup(commands: SlashCommand[] | null = LIST) {
  const sent: ClientMessage[] = [];
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: (m: ClientMessage) => (sent.push(m), true), close() {} })) as never });
  if (commands) store.dispatch(serverEvent({ kind: 'commands', commands }));
  render(<Provider store={store}><TooltipProvider><Composer /></TooltipProvider></Provider>);
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  box.focus();
  const type = (value: string, caret = value.length) => {
    fireEvent.change(box, { target: { value } });
    box.setSelectionRange(caret, caret);
    fireEvent.input(box);
  };
  const names = () => screen.queryAllByRole('option').map((o) => o.querySelector('span')!.textContent);
  return { sent, store, box, type, names };
}

it('a lone slash offers the whole list, the user\'s own first as the server ordered it', () => {
  const { type, names } = setup();
  type('/');
  expect(names()).toEqual(['/ping', '/hello', '/compact']);
  expect(screen.getByText('built-in')).toBeInTheDocument();
  expect(screen.getByText('[name]')).toBeInTheDocument();
});

it('typing narrows the list; the match is bold', () => {
  const { type, names } = setup();
  type('/he');
  expect(names()).toEqual(['/hello']);
  expect(screen.getByRole('option').querySelector('mark')!.textContent).toBe('h');
});

it('opens only for a slash at the start of the draft and only in its first word', () => {
  const { type } = setup();
  type('hi /pi');
  expect(screen.queryByRole('listbox')).toBeNull();
  type(' /pi');
  expect(screen.queryByRole('listbox')).toBeNull();
  type('/ping arg');
  expect(screen.queryByRole('listbox')).toBeNull();
  type('/ping arg', 3); // back in the first word
  expect(screen.getByRole('listbox')).toBeInTheDocument();
});

it('no list yet: the picker stays closed and typing still works', () => {
  const { type, box, store } = setup(null);
  type('/pi');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(store.getState().composer.draft).toBe('/pi');
  fireEvent.keyDown(box, { key: 'Enter' }); // nothing to take the key: the composer sends it
});

it('a command that is not offered: closed, and Enter sends it as typed', () => {
  const { type, box, sent } = setup();
  type('/model');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(sent.find((m) => m.type === 'send')).toMatchObject({ text: '/model' });
});

it('arrows move (wrapping), Enter picks: /name and a space, the caret after it, the draft in the store', () => {
  const { type, box, store } = setup();
  type('/');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(box.value).toBe('/compact ');
  expect(box.selectionStart).toBe('/compact '.length);
  expect(store.getState().composer.draft).toBe('/compact ');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('Tab picks too, replacing the whole first word and keeping the arguments after it', () => {
  const { type, box } = setup();
  type('/pi arg', 2);
  fireEvent.keyDown(box, { key: 'Tab' });
  expect(box.value).toBe('/ping arg');
  expect(box.selectionStart).toBe('/ping '.length);
});

it('Esc closes without picking; Enter with Cmd passes through to send', () => {
  const { type, box, sent } = setup();
  type('/he');
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box.value).toBe('/he');
  type('/ping');
  fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(sent.find((m) => m.type === 'send')).toMatchObject({ text: '/ping' });
});

it('a click picks', () => {
  const { type, box } = setup();
  type('/');
  fireEvent.click(screen.getAllByRole('option')[1]);
  expect(box.value).toBe('/hello ');
});

it('a new list from the server replaces the shown one', () => {
  const { type, names, store } = setup();
  type('/');
  expect(names()).toHaveLength(3);
  store.dispatch(serverEvent({ kind: 'commands', commands: [{ name: 'fresh', description: '' }] }));
  type('/');
  expect(names()).toEqual(['/fresh']);
});

it('is not offered in the comment popup', () => {
  const pending: PendingSelection = {
    anchor: { source: { kind: 'message', id: 'a1' }, start: 0, end: 1, quote: 'q', prefix: '', suffix: '' },
    rect: { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20, x: 10, y: 20, toJSON() {} } as DOMRect,
  };
  const store = makeStore({ url: 'ws://x', connect: ((_u: unknown, _e: unknown, s: (x: 'open') => void) => (s('open'), { send: () => true, close() {} })) as never });
  store.dispatch(serverEvent({ kind: 'commands', commands: LIST }));
  render(<Provider store={store}><TooltipProvider><CommentPopup pending={pending} onClose={() => {}} /></TooltipProvider></Provider>);
  const box = screen.getByPlaceholderText('Comment…') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: '/' } });
  box.setSelectionRange(1, 1);
  fireEvent.input(box);
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('Shift+Tab closes the menu and lets the composer cycle the mode; nothing is picked', () => {
  const { type, box, store, sent } = setup();
  store.dispatch(serverEvent({ kind: 'mode', mode: 'default' }));
  type('/pi');
  fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(box.value).toBe('/pi');
  expect(sent.find((m) => m.type === 'mode')).toBeDefined();
});

it('moving the caret by keys into the first word opens the menu; Esc keeps it shut for that word until the caret leaves it', () => {
  const { type, box } = setup();
  type('/ping arg', 9);
  expect(screen.queryByRole('listbox')).toBeNull();
  box.setSelectionRange(3, 3);
  act(() => { document.dispatchEvent(new Event('selectionchange')); });
  expect(screen.getByRole('listbox')).toBeInTheDocument();
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  box.setSelectionRange(2, 2); // an arrow key inside the same word
  act(() => { document.dispatchEvent(new Event('selectionchange')); });
  expect(screen.queryByRole('listbox')).toBeNull();
  box.setSelectionRange(8, 8); // out of the word
  act(() => { document.dispatchEvent(new Event('selectionchange')); });
  box.setSelectionRange(3, 3); // and back in
  act(() => { document.dispatchEvent(new Event('selectionchange')); });
  expect(screen.getByRole('listbox')).toBeInTheDocument();
});
