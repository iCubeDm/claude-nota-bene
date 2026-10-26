import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClientMessage, Mode, ServerEvent } from '@nota-bene/shared';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Composer } from '@/composer/Composer.tsx';
import { setLang } from '@/i18n/index.ts';
import { makeStore } from '@/store/store.ts';
import { planApproved, restartAgent, selectRestarting, selectSwitching, switchSession } from './slice.ts';

// Radix popper measures with ResizeObserver, which jsdom lacks
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
        <Composer />
      </TooltipProvider>
    </Provider>,
  );
  const echo = (mode: Mode) => act(() => ev({ kind: 'mode', mode }));
  return { sent, store, echo, ev: () => ev, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}
const raw = (sent: ClientMessage[]) => sent.filter((m) => m.type === 'mode');
/** the mode messages without their (random) ids */
const modes = (sent: ClientMessage[]) => raw(sent).map((m) => ({ type: m.type, mode: (m as { mode: Mode }).mode }));

it('Shift+Tab cycles auto to default and sends once', async () => {
  const { sent, echo, box, store } = setup();
  echo('auto');
  box.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(store.getState().controls.mode).toBe('default');
  expect(modes(sent)).toEqual([{ type: 'mode', mode: 'default' }]);
  expect(box).toHaveFocus();
});

it('Shift+Tab does nothing before the mode is known', async () => {
  const { sent, box } = setup();
  box.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(modes(sent)).toEqual([]);
});

it('the server echo sets the mode and does not send', () => {
  const { sent, echo, store } = setup();
  echo('plan');
  echo('plan');
  expect(store.getState().controls.mode).toBe('plan');
  expect(modes(sent)).toEqual([]);
});

it('Shift+Tab yields to an open @ picker', async () => {
  const { sent, echo, box } = setup();
  echo('default');
  // an open picker with an item takes Tab at window capture; emulate that with a capture listener
  const take = (e: KeyboardEvent) => { if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); } };
  window.addEventListener('keydown', take, true);
  box.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  window.removeEventListener('keydown', take, true);
  expect(modes(sent)).toEqual([]);
});

it('plan approval restores the earlier mode once', () => {
  const { sent, echo, store } = setup();
  echo('acceptEdits');
  echo('plan'); // modeBeforePlan = acceptEdits
  expect(store.getState().controls.modeBeforePlan).toBe('acceptEdits');
  act(() => void store.dispatch(planApproved()));
  expect(store.getState().controls.restoreAfterPlan).toBe('acceptEdits');
  echo('default'); // the CLI drops to default after approval
  expect(modes(sent)).toEqual([{ type: 'mode', mode: 'acceptEdits' }]);
  expect(store.getState().controls.restoreAfterPlan).toBeNull();
  echo('acceptEdits'); // the echo of our own pick: no second send
  echo('default');
  expect(modes(sent)).toHaveLength(1);
});

it('plan approval clears the restore without a send when the echo already matches', () => {
  const { sent, echo, store } = setup();
  echo('default');
  echo('plan');
  act(() => void store.dispatch(planApproved()));
  echo('default');
  expect(modes(sent)).toEqual([]);
  expect(store.getState().controls.restoreAfterPlan).toBeNull();
});

it('the pill menu picks a mode and Esc closes it with preventDefault', async () => {
  const { sent, echo } = setup();
  echo('default');
  const pill = screen.getByRole('button', { name: /Agent mode/ });
  expect(pill).toHaveTextContent('Default');
  await userEvent.click(pill);
  expect(await screen.findByText('Asks before edits and commands')).toBeInTheDocument();
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => void document.activeElement!.dispatchEvent(esc));
  expect(esc.defaultPrevented).toBe(true);
  expect(screen.queryByText('Asks before edits and commands')).toBeNull();
  await userEvent.click(pill);
  await userEvent.click(await screen.findByText('Plan'));
  expect(modes(sent)).toEqual([{ type: 'mode', mode: 'plan' }]);
  expect(pill).toHaveTextContent('Plan');
});

// --- switching across a reconnect, and plan-restore across a replay ---
function setupConn() {
  const sent: ClientMessage[] = [];
  let ev!: (e: ServerEvent) => void;
  let st!: (s: 'open' | 'closed') => void;
  const connect = vi.fn((_u: string, onEvent: (e: ServerEvent) => void, onState: (s: 'open' | 'closed') => void) => {
    ev = onEvent; st = onState;
    onState('open');
    return { send: (m: ClientMessage) => (sent.push(m), true), close() {} };
  });
  const store = makeStore({ url: 'ws://x', connect: connect as never });
  return { sent, store, ev: (e: ServerEvent) => act(() => ev(e)), conn: (s: 'open' | 'closed') => act(() => st(s)) };
}
const sess = { kind: 'session', id: 's1', root: '/r', title: null, model: null } as const;

it('a replay that carries the settled session ends a switch after a socket drop', () => {
  const { store, ev, conn } = setupConn();
  act(() => void store.dispatch(switchSession('s1', '/r')));
  expect(selectSwitching(store.getState())).toBe(true);
  conn('closed');
  conn('open');
  ev({ kind: 'replay', events: [sess] });
  expect(selectSwitching(store.getState())).toBe(false);
  expect(store.getState().controls.restarting).toBe(false);
});

it('a restart interrupted by a socket drop is released by a replay with the session', () => {
  const { store, ev, conn } = setupConn();
  act(() => void store.dispatch(restartAgent()));
  expect(selectRestarting(store.getState())).toBe(true);
  conn('closed');
  conn('open');
  ev({ kind: 'replay', events: [sess] });
  expect(selectSwitching(store.getState())).toBe(false);
  expect(selectRestarting(store.getState())).toBe(false);
});

it('an empty replay keeps the switch until the live session arrives', () => {
  const { store, ev, conn } = setupConn();
  act(() => void store.dispatch(switchSession('s1', '/r')));
  conn('closed');
  conn('open');
  ev({ kind: 'replay', events: [] });
  expect(selectSwitching(store.getState())).toBe(true);
  ev(sess);
  expect(selectSwitching(store.getState())).toBe(false);
});

it('a replay drops the plan-restore state: a later mode echo sends nothing', () => {
  const { sent, store, ev } = setupConn();
  ev({ kind: 'mode', mode: 'acceptEdits' });
  ev({ kind: 'mode', mode: 'plan' });
  act(() => void store.dispatch(planApproved()));
  ev({ kind: 'replay', events: [] });
  expect(store.getState().controls.modeBeforePlan).toBeNull();
  ev({ kind: 'mode', mode: 'default' });
  expect(modes(sent)).toEqual([]);
});

const echo0 = (ev: () => (e: ServerEvent) => void, mode: Mode) => act(() => ev()({ kind: 'mode', mode }));
const ids = (sent: ClientMessage[]) => raw(sent).map((m) => (m as { id?: string }).id!);

it('quick Shift+Tabs: a late echo of an earlier press neither moves the pill back nor skews the next press', async () => {
  const { sent, ev, box, store } = setup();
  echo0(ev, 'default');
  box.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}'); // acceptEdits
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}'); // plan
  const [a1] = ids(sent);
  act(() => ev()({ kind: 'mode', mode: 'acceptEdits', ack: a1 })); // the first press's answer, after the second was shown
  expect(store.getState().controls.mode).toBe('plan');
  act(() => ev()({ kind: 'mode', mode: 'acceptEdits' })); // the CLI's own status echo meanwhile: no ack, ignored
  expect(store.getState().controls.mode).toBe('plan');
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}'); // counts on from plan
  expect(modes(sent).map((m) => m.mode)).toEqual(['acceptEdits', 'plan', 'auto']);
  const [, a2, a3] = ids(sent);
  act(() => ev()({ kind: 'mode', mode: 'plan', ack: a2 }));
  expect(store.getState().controls.mode).toBe('auto');
  act(() => ev()({ kind: 'mode', mode: 'auto', ack: a3 }));
  expect(store.getState().controls.mode).toBe('auto');
  expect(store.getState().controls.modeInFlight).toEqual([]);
  act(() => ev()({ kind: 'mode', mode: 'default' })); // nothing in flight: another window's change applies
  expect(store.getState().controls.mode).toBe('default');
});

it('the ack of the last change shows the server\'s mode, also when it refused the change', async () => {
  const { sent, ev, box, store } = setup();
  echo0(ev, 'default');
  box.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  act(() => ev()({ kind: 'mode', mode: 'default', ack: ids(sent)[0] }));
  expect(store.getState().controls.mode).toBe('default');
  expect(store.getState().controls.modeInFlight).toEqual([]);
});

it('a replay drops the changes in flight, so the next echo applies', async () => {
  const { ev, box, store } = setup();
  echo0(ev, 'default');
  box.focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  act(() => ev()({ kind: 'replay', events: [] }));
  act(() => ev()({ kind: 'mode', mode: 'plan' }));
  expect(store.getState().controls.mode).toBe('plan');
});
