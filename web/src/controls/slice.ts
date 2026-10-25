import { createAction, createListenerMiddleware, createSlice } from '@reduxjs/toolkit';
import { MODES, type Mode } from '@nota-bene/shared';
import { serverEvent, type AppThunk, type RootState } from '../store/store.ts';

/**
 * `switching`: a `switch` we sent is in flight. `asked` from the click until the reset's `replay` (the server accepted
 * it and tore the old session down), then `committed` until the new session is announced.
 */
export type SwitchPhase = 'asked' | 'committed';
export type ControlsState = { mode: Mode | null; modeBeforePlan: Mode | null; restoreAfterPlan: Mode | null; switching: SwitchPhase | null };

/** The mode as the UI shows it: null until the server has told us (or the user picked one). */
const initial: ControlsState = { mode: null, modeBeforePlan: null, restoreAfterPlan: null, switching: null };

/** Entering `plan` from X remembers X (prototype setModeUI). */
function setMode(s: ControlsState, m: Mode): void {
  if (m === 'plan' && s.mode && s.mode !== 'plan') s.modeBeforePlan = s.mode;
  s.mode = m;
}

/** Local, optimistic mode change: no message is sent from here (see pickMode). */
const modeSet = createAction<Mode>('controls/modeSet');

export const controlsSlice = createSlice({
  name: 'controls',
  initialState: initial,
  reducers: {
    /** M4-07 calls this when the plan card is approved: the CLI then drops to `default`, and we go back to where we were. */
    planApproved: (s) => void (s.restoreAfterPlan = s.modeBeforePlan),
    restoreCleared: (s) => void (s.restoreAfterPlan = null),
    switchStarted: (s) => void (s.switching = 'asked'),
  },
  extraReducers: (b) => {
    b.addCase(modeSet, (s, a) => setMode(s, a.payload));
    b.addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      if (ev.kind === 'mode') setMode(s, ev.mode);
      if (!s.switching) return;
      // Only these end a switch. A `session` before the reset is the old session's (a title refresh); a `busy` error
      // answers someone's send or command (any socket's: errors are broadcast), never a switch, which the server
      // refuses as `switch`. Clearing on those would let a send go out mid-switch and lose the draft.
      if (ev.kind === 'replay' && s.switching === 'asked') s.switching = 'committed';
      else if (ev.kind === 'session' && s.switching === 'committed') s.switching = null;
      else if (ev.kind === 'server-error' && ev.where === 'switch') s.switching = null;
    });
  },
});

export const { planApproved } = controlsSlice.actions;
const { restoreCleared, switchStarted } = controlsSlice.actions;

export const selectMode = (s: RootState): Mode | null => s.controls.mode;
export const selectSwitching = (s: RootState): boolean => s.controls.switching !== null;

/** Optimistic: set locally, then send. The server echo sets the same value again and never sends (reducers cannot). */
export const pickMode = (mode: Mode): AppThunk => (dispatch, getState, { send }) => {
  const c = getState().controls;
  // mid-switch the server ignores it and announces the new session's mode: an optimistic pill would lie
  if (c.mode === mode || c.switching) return;
  dispatch(modeSet(mode));
  send({ type: 'mode', mode });
};

export const nextMode = (m: Mode): Mode => MODES[(MODES.indexOf(m) + 1) % MODES.length];

/**
 * Plan restore: approving a plan makes the CLI drop to `default`. On the echo of a non-plan mode with
 * `restoreAfterPlan` set, clear it, and if the echo differs, pick the remembered mode once.
 * A listener (not a reducer): it dispatches a thunk that sends.
 */
export const controlsListener = createListenerMiddleware();
controlsListener.startListening({
  // lazy match: store.ts and this file import each other, so serverEvent is not yet defined when this runs at load
  predicate: (a) => serverEvent.match(a),
  effect: (action, api) => {
    const ev = (action as ReturnType<typeof serverEvent>).payload;
    if (ev.kind !== 'mode' || ev.mode === 'plan') return;
    const want = (api.getState() as RootState).controls.restoreAfterPlan;
    if (!want) return;
    api.dispatch(restoreCleared());
    if (want !== ev.mode) (api.dispatch as (t: AppThunk) => void)(pickMode(want));
  },
});

/** compact / clear. Refused while busy or switching (the server would answer `busy` too); the confirmation for clear is the caller's. */
export const runCommand = (name: 'compact' | 'clear'): AppThunk => (_d, getState, { send }) => {
  const st = getState();
  if (st.feed.busy || st.controls.switching) return;
  send({ type: 'command', name });
};

/**
 * Open another session (`id`, in its own folder `dir`) or a new one (`id` null, in `dir`). Refused while busy, while
 * another switch runs or offline; the result says which, for the caller's feedback. The confirmation is the caller's.
 * Switching stays on until the new session's `session` event (after the reset's `replay`) or a `switch` server-error.
 */
export type SwitchResult = 'sent' | 'busy' | 'switching' | 'offline';
export const switchSession = (id: string | null, dir: string): AppThunk<SwitchResult> => (dispatch, getState, { send }) => {
  const st = getState();
  if (st.controls.switching) return 'switching';
  if (st.feed.busy) return 'busy';
  if (st.conn.state !== 'open' || !send({ type: 'switch', id, dir })) return 'offline';
  dispatch(switchStarted());
  return 'sent';
};
