import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommentsPanel } from '@/comments/CommentsPanel.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setDraft } from '@/composer/slice.ts';
import { setLang } from '@/i18n/index.ts';
import { Header } from '@/shell/Header.tsx';
import { makeStore } from '@/store/store.ts';
import { ago, brief, groupSessions, kb, type SessionsView } from './SessionPicker.tsx';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const NOW = Date.now();
const A = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = '33333333-cccc-4ccc-8ccc-cccccccccccc';
const D = '44444444-dddd-4ddd-8ddd-dddddddddddd';
const VIEW: SessionsView = {
  current: A,
  root: '/Users/me/proj',
  sessions: [
    { id: B, title: 'other one', at: NOW - 5 * 60_000, size: 2_400_000, cwd: '/Users/me/other' },
    { id: A, title: 'current talk', at: NOW, size: 12_000, cwd: '/Users/me/proj' },
    { id: C, title: '', at: NOW - 3 * 3600_000, size: 800, cwd: '/Users/me/proj' },
    { id: D, title: 'third folder', at: NOW - 2 * 86400_000, size: 5000, cwd: '/tmp/x' },
  ],
};

let view: SessionsView;
beforeEach(() => {
  setLang('en');
  localStorage.clear();
  view = VIEW;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/sessions') return new Response(JSON.stringify(view));
    if (url === '/sources') return new Response(JSON.stringify([]));
    return new Response('nope', { status: 404 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  let state!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: string, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent;
    state = onState;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  render(
    <Provider store={store}>
      <TooltipProvider>
        <Header />
        <Composer />
        <CommentsPanel onSend={() => {}} />
      </TooltipProvider>
    </Provider>,
  );
  const emit = (...es: ServerEvent[]) => act(() => es.forEach(ev));
  emit({ kind: 'session', id: A, root: '/Users/me/proj', title: null, model: null });
  const switches = () => sent.filter((m) => m.type === 'switch');
  return { sent, store, emit, switches, offline: () => act(() => state('closed')) };
}
const btn = () => screen.getByRole('button', { name: 'Sessions' });
const menu = () => screen.getByRole('dialog', { name: 'Sessions' });
async function openPicker() {
  await userEvent.click(btn());
  await screen.findByText('current talk');
}
const rows = () => [...menu().querySelectorAll('[data-sess-group], [data-sess-item]')].map((el) =>
  el.hasAttribute('data-sess-group') ? `# ${el.textContent}${el.hasAttribute('data-here') ? ' (here)' : ''}` : el.querySelector('[data-t]')!.textContent!);

it('groups: new first, this project marked, then other folders in first-appearance order; meta line id8 · ago · size', async () => {
  setup();
  await openPicker();
  expect(rows()).toEqual([
    '+ new session in this project',
    '# this project · ~/proj (here)',
    'current talk',
    '(untitled)',
    '# ~/other',
    'other one',
    '# /tmp/x',
    'third folder',
  ]);
  const cur = screen.getByText('current talk').closest('button')!;
  expect(cur).toHaveTextContent('11111111 · just now · 12 KB · open now');
  expect(screen.getByText('other one').closest('button')).toHaveTextContent('22222222 · 5 min ago · 2.4 MB');
  expect(screen.getByText('(untitled)').closest('button')).toHaveTextContent('33333333 · 3 h ago · 1 KB');
  expect(menu().className).toContain('w-[460px]');
});

it('the filter is focused, matches title + folder, keeps "new" and hides empty groups', async () => {
  setup();
  await openPicker();
  const f = screen.getByPlaceholderText('Search by title or folder…');
  await waitFor(() => expect(f).toHaveFocus());
  await userEvent.type(f, 'OTHER');
  expect(rows()).toEqual(['+ new session in this project', '# ~/other', 'other one']);
  await userEvent.clear(f);
  await userEvent.type(f, '/tmp');
  expect(rows()).toEqual(['+ new session in this project', '# /tmp/x', 'third folder']);
});

it('the current session is inert', async () => {
  const { switches } = setup();
  await openPicker();
  const cur = screen.getByText('current talk').closest('button')!;
  expect(cur).toBeDisabled();
  fireEvent.click(cur);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByText(/Open session/)).toBeNull();
  expect(switches()).toEqual([]);
});

it('picking a session in another folder asks (open + move + warn), then sends switch with its id and cwd', async () => {
  const { switches, emit, store } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('other one'));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “other one”?' });
  expect(dlg).toHaveTextContent('the window will switch to the project /Users/me/other');
  expect(dlg).toHaveTextContent('Don’t keep this same session open in a terminal claude');
  expect(dlg).not.toHaveTextContent(/server restarts/i);
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([{ type: 'switch', id: B, dir: '/Users/me/other' }]);
  expect(document.getElementById('conn')).toHaveTextContent('switching…');
  expect(btn()).toBeDisabled();
  emit({ kind: 'replay', events: [] }, { kind: 'session', id: B, root: '/Users/me/other', title: 'other one', model: null });
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(store.getState().controls.switching).toBeNull();
  expect(btn()).toBeEnabled();
});

it('a session of this folder asks without the move line', async () => {
  const { switches } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('(untitled)'));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “(untitled)”?' });
  expect(dlg).not.toHaveTextContent('another folder');
  await userEvent.keyboard('{Enter}');
  expect(switches()).toEqual([{ type: 'switch', id: C, dir: '/Users/me/proj' }]);
});

it('"new session here" sends id null and the root; cancel sends nothing', async () => {
  const { switches } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('+ new session in this project'));
  let dlg = await screen.findByRole('dialog', { name: 'Start a new session?' });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
  expect(switches()).toEqual([]);
  await openPicker();
  await userEvent.click(screen.getByText('+ new session in this project'));
  dlg = await screen.findByRole('dialog', { name: 'Start a new session?' });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([{ type: 'switch', id: null, dir: '/Users/me/proj' }]);
});

it('disabled while the agent is busy', () => {
  const { emit } = setup();
  expect(btn()).toBeEnabled();
  emit({ kind: 'user', id: 'u1', text: 'hi', ts: 1 });
  expect(btn()).toBeDisabled();
});

it('while switching: Send (composer and panel) is off with the switching title, the draft stays; a switch error ends it', async () => {
  const { emit, store, sent } = setup();
  act(() => { store.dispatch(setDraft('keep me')); });
  await openPicker();
  await userEvent.click(screen.getByText('other one'));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch' }));
  const send = screen.getAllByRole('button', { name: 'Send', hidden: true });
  expect(send).toHaveLength(2);
  for (const b of send) {
    expect(b).toBeDisabled();
    expect(b.closest('[title]')).toHaveAttribute('title', 'switching…');
  }
  const box = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(box.value).toBe('keep me');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(sent.filter((m) => m.type === 'send')).toEqual([]);
  emit({ kind: 'server-error', where: 'switch', message: 'no session lives in /x' });
  expect(store.getState().controls.switching).toBeNull();
  expect(document.getElementById('conn')).toHaveTextContent('');
  expect(screen.getAllByRole('button', { name: 'Send', hidden: true })[0]).toBeEnabled();
  expect(box.value).toBe('keep me');
});

async function confirmOther() {
  await openPicker();
  await userEvent.click(screen.getByText('other one'));
  await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch' }));
}

it('mid-switch: Compact and the mode pill are off; busy errors (any socket\'s) and an old-session title refresh do not end it', async () => {
  const { emit, store, sent } = setup();
  emit({ kind: 'mode', mode: 'auto' });
  act(() => { store.dispatch(setDraft('keep me')); });
  await confirmOther();
  expect(store.getState().controls.switching).toBe('asked');
  expect(screen.getByRole('button', { name: /Compact context/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /Clear context/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Agent mode/ })).toBeDisabled();
  // a compact (here or in another window) refused as busy, then some other socket's busy send
  emit({ kind: 'server-error', where: 'busy', message: 'the session is switching; the command was not sent' });
  emit({ kind: 'server-error', where: 'busy', message: 'the session is switching; the message was not sent' });
  // the old session's title refresh, before the reset
  emit({ kind: 'session', id: A, root: '/Users/me/proj', title: 'renamed', model: null });
  expect(store.getState().controls.switching).toBe('asked');
  const send = screen.getAllByRole('button', { name: 'Send', hidden: true })[0];
  expect(send).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(sent.filter((m) => m.type === 'send' || m.type === 'command')).toEqual([]);
  expect(store.getState().composer.draft).toBe('keep me');
  // the reset commits it; a busy error still does not end it; the new session does
  emit({ kind: 'replay', events: [] });
  expect(store.getState().controls.switching).toBe('committed');
  emit({ kind: 'server-error', where: 'busy', message: 'x' });
  expect(store.getState().controls.switching).toBe('committed');
  emit({ kind: 'session', id: B, root: '/Users/me/other', title: 'other one', model: null });
  expect(store.getState().controls.switching).toBeNull();
  expect(store.getState().composer.draft).toBe('keep me');
});

it('after the confirm the focus goes to the composer (the picker button is disabled)', async () => {
  setup();
  await confirmOther();
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
});

it('another window switching closes the menu and an open question', async () => {
  const { emit, switches } = setup();
  await openPicker();
  emit({ kind: 'replay', events: [] }, { kind: 'session', id: D, root: '/tmp/x', title: null, model: null });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull());
  await openPicker();
  await userEvent.click(screen.getByText('other one'));
  await screen.findByRole('dialog', { name: 'Open session “other one”?' });
  emit({ kind: 'session', id: C, root: '/Users/me/proj', title: null, model: null });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(switches()).toEqual([]);
});

it('a confirm refused because the agent started meanwhile says so', async () => {
  const { emit, switches } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('other one'));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “other one”?' });
  emit({ kind: 'user', id: 'u1', text: 'from another window', ts: 1 });
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([]);
  expect(screen.getByRole('status')).toHaveTextContent('Could not switch: agent is working…');
});

it('a confirm refused while offline says so', async () => {
  const { switches, offline } = setup();
  await openPicker();
  await userEvent.click(screen.getByText('other one'));
  const dlg = await screen.findByRole('dialog', { name: 'Open session “other one”?' });
  offline();
  await userEvent.click(within(dlg).getByRole('button', { name: 'Switch' }));
  expect(switches()).toEqual([]);
  expect(screen.getByRole('status')).toHaveTextContent('Could not switch: no connection to the server…');
});

it('a failed /sessions load says so in one short line, never an HTML body', async () => {
  setup();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html><body><h1>Internal</h1>' + 'x'.repeat(500) + '</body></html>', { status: 500 })));
  await userEvent.click(btn());
  expect(await screen.findByText('Could not load sessions: HTTP 500')).toBeInTheDocument();
  expect(brief(500, 'y'.repeat(300))).toHaveLength(120);
  expect(brief(500, '  cannot\n list   sessions ')).toBe('cannot list sessions');
});

it('formatting: ago and kb as in the prototype', () => {
  setLang('ru');
  expect(ago(NOW - 20_000, NOW)).toBe('только что');
  expect(ago(NOW - 59 * 60_000, NOW)).toBe('59 мин назад');
  expect(ago(NOW - 90 * 60_000, NOW)).toBe('2 ч назад');
  expect(kb(1_500_000)).toBe('1.5 МБ');
  expect(kb(1_000_000)).toBe('1000 КБ');
  setLang('en');
  expect(ago(NOW - 3 * 86400_000, NOW)).toBe(new Date(NOW - 3 * 86400_000).toLocaleDateString('en', { day: 'numeric', month: 'short' }));
  expect(groupSessions(VIEW).map((g) => g.dir)).toEqual(['/Users/me/proj', '/Users/me/other', '/tmp/x']);
  expect(groupSessions({ ...VIEW, sessions: [VIEW.sessions[0]] }).map((g) => g.dir)).toEqual(['/Users/me/other']);
});
