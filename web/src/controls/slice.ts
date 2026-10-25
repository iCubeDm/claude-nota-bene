import { createAction, createListenerMiddleware, createSlice } from '@reduxjs/toolkit';
import { MODES, type Mode } from '@nota-bene/shared';
import { serverEvent, type AppThunk, type RootState } from '../store/store.ts';

export type ControlsState = { mode: Mode | null; modeBeforePlan: Mode | null; restoreAfterPlan: Mode | null };

/** The mode as the UI shows it: null until the server has told us (or the user picked one). */
const initial: ControlsState = { mode: null, modeBeforePlan: null, restoreAfterPlan: null };

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
  },
  extraReducers: (b) => {
    b.addCase(modeSet, (s, a) => setMode(s, a.payload));
    b.addCase(serverEvent, (s, a) => {
      if (a.payload.kind === 'mode') setMode(s, a.payload.mode);
    });
  },
});

export const { planApproved } = controlsSlice.actions;
const { restoreCleared } = controlsSlice.actions;

export const selectMode = (s: RootState): Mode | null => s.controls.mode;

/** Optimistic: set locally, then send. The server echo sets the same value again and never sends (reducers cannot). */
export const pickMode = (mode: Mode): AppThunk => (dispatch, getState, { send }) => {
  if (getState().controls.mode === mode) return;
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

/** compact / clear. Refused while busy (the server would answer `busy` too); the confirmation for clear is the caller's. */
export const runCommand = (name: 'compact' | 'clear'): AppThunk => (_d, getState, { send }) => {
  if (getState().feed.busy) return;
  send({ type: 'command', name });
};
