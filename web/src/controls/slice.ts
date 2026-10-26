import { createAction, type PayloadAction, createListenerMiddleware, createSlice } from '@reduxjs/toolkit';
import { MODES, type IdleCompact, type Mode } from '@nota-bene/shared';
import { t } from '../i18n/index.ts';
import { toast } from '../shell/toast.ts';
import { serverEvent, type AppThunk, type RootState } from '../store/store.ts';

/**
 * `switching`: a `switch` we sent is in flight. `asked` from the click until the reset's `replay` (the server accepted
 * it and tore the old session down), then `committed` until the new session is announced.
 */
export type SwitchPhase = 'asked' | 'committed';
export type ControlsState = { mode: Mode | null; modeBeforePlan: Mode | null; restoreAfterPlan: Mode | null; switching: SwitchPhase | null;
  /** the running "switch" is a ↻ restart (same phases and end; only the header label differs) */
  restarting: boolean;
  /** the SDK's predicted next prompt; ghost text in an empty, idle composer. Cleared by anything that moves the conversation on. */
  suggestion: string;
  /** the session last announced, to tell a real change from the server's title refresh (same id, new title) */
  seen: { id: string | null; root: string } | null;
  /** idle compaction of this project, as the server last said (null until it has) */
  idleCompact: IdleCompact | null;
};

/** The mode as the UI shows it: null until the server has told us (or the user picked one). */
const initial: ControlsState = { mode: null, modeBeforePlan: null, restoreAfterPlan: null, switching: null, restarting: false, suggestion: '', seen: null, idleCompact: null };

/** Entering `plan` from X remembers X (prototype setModeUI). */
function setMode(s: ControlsState, m: Mode): void {
  if (m === 'plan' && s.mode && s.mode !== 'plan') s.modeBeforePlan = s.mode;
  s.mode = m;
}

/** Local, optimistic mode change: no message is sent from here (see pickMode). */
const modeSet = createAction<Mode>('controls/modeSet');
/** Local, optimistic idle-compaction toggle (see toggleIdleCompact). */
const idleCompactSet = createAction<boolean>('controls/idleCompactSet');

export const controlsSlice = createSlice({
  name: 'controls',
  initialState: initial,
  reducers: {
    /** M4-07 calls this when the plan card is approved: the CLI then drops to `default`, and we go back to where we were. */
    planApproved: (s) => void (s.restoreAfterPlan = s.modeBeforePlan),
    restoreCleared: (s) => void (s.restoreAfterPlan = null),
    /** the full-restart wait gave up (error answer or no reconnect): release the UI */
    switchCleared: (s) => void ((s.switching = null), (s.restarting = false)),
    switchStarted: (s, a: PayloadAction<boolean | undefined>) => void ((s.switching = 'asked'), (s.restarting = a.payload === true)),
  },
  extraReducers: (b) => {
    b.addCase(modeSet, (s, a) => setMode(s, a.payload));
    b.addCase(idleCompactSet, (s, a) => void (s.idleCompact && (s.idleCompact.on = a.payload)));
    b.addCase(serverEvent, (s, a) => {
      const ev = a.payload;
      if (ev.kind === 'mode') setMode(s, ev.mode);
      if (ev.kind === 'idle-compact') s.idleCompact = ev.state;
      // stale once the conversation moves on: a user turn (live or replayed), a reset, a replay, another session
      if (ev.kind === 'replay') { s.modeBeforePlan = null; s.restoreAfterPlan = null; } // plan-restore belongs to one conversation
      if (ev.kind === 'user' || ev.kind === 'replay') s.suggestion = '';
      else if (ev.kind === 'session') {
        // the server re-announces after every result (title refresh): only a different id or root is a new session
        if (s.seen && (s.seen.id !== ev.id || s.seen.root !== ev.root)) s.suggestion = '';
        s.seen = { id: ev.id, root: ev.root };
      }
      else if (ev.kind === 'sdk') {
        const m = ev.m as unknown as { type?: string; suggestion?: unknown };
        if (m.type === 'conversation_reset') s.suggestion = '';
        else if (m.type === 'prompt_suggestion' && typeof m.suggestion === 'string') s.suggestion = m.suggestion.trim();
      }
      if (!s.switching) return;
      // Only these end a switch. A `session` before the reset is the old session's (a title refresh); a `busy` error
      // answers someone's send or command (any socket's: errors are broadcast), never a switch, which the server
      // refuses as `switch`. Clearing on those would let a send go out mid-switch and lose the draft.
      // A replay that already carries the settled session (a reconnect after the switch finished) ends it too; an empty
      // one (the teardown's reset, or a reconnect mid-switch) keeps it until the live `session` arrives.
      if (ev.kind === 'replay' && ev.events.some((e) => e.kind === 'session' && (e.id || e.root))) s.switching = null;
      else if (ev.kind === 'replay' && s.switching === 'asked') s.switching = 'committed';
      else if (ev.kind === 'session' && s.switching === 'committed') s.switching = null;
      else if (ev.kind === 'server-error' && ev.where === 'switch') s.switching = null;
      if (!s.switching) s.restarting = false;
    });
  },
});

export const { planApproved } = controlsSlice.actions;
const { restoreCleared, switchStarted, switchCleared } = controlsSlice.actions;

export const selectMode = (s: RootState): Mode | null => s.controls.mode;
export const selectSuggestion = (s: RootState): string => s.controls.suggestion;
export const selectSwitching = (s: RootState): boolean => s.controls.switching !== null;
export const selectRestarting = (s: RootState): boolean => s.controls.restarting;

/** Optimistic: set locally, then send. The server echo sets the same value again and never sends (reducers cannot). */
export const pickMode = (mode: Mode): AppThunk => (dispatch, getState, { send }) => {
  const c = getState().controls;
  // mid-switch the server ignores it and announces the new session's mode: an optimistic pill would lie
  if (c.mode === mode || c.switching) return;
  dispatch(modeSet(mode));
  send({ type: 'mode', mode });
};

export const selectIdleCompact = (s: RootState): IdleCompact | null => s.controls.idleCompact;

/** Optimistic, like pickMode; the server's echo (to every socket) confirms it. Off while Claude Code's settings block it. */
export const toggleIdleCompact = (): AppThunk => (dispatch, getState, { send }) => {
  const st = getState().controls.idleCompact;
  if (!st || st.blocked) return;
  dispatch(idleCompactSet(!st.on));
  send({ type: 'idle-compact', on: !st.on });
};

export const ACTIVITY_THROTTLE_MS = 30_000;
let lastActivity = -Infinity;
/** The user touched the UI: tell the server at most once per ACTIVITY_THROTTLE_MS (the idle clock is minutes). */
export const reportActivity = (now = Date.now()): AppThunk => (_d, _g, { send }) => {
  if (now - lastActivity < ACTIVITY_THROTTLE_MS) return;
  if (send({ type: 'activity' })) lastActivity = now;
};
/** tests */
export const resetActivityThrottle = (): void => void (lastActivity = -Infinity);

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
export type CommandResult = 'sent' | 'busy' | 'switching' | 'offline';
export const runCommand = (name: 'compact' | 'clear'): AppThunk<CommandResult> => (_d, getState, { send }) => {
  const st = getState();
  if (st.controls.switching) return 'switching';
  if (st.feed.busy) return 'busy';
  return send({ type: 'command', name }) ? 'sent' : 'offline';
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
  dispatch(switchStarted(false));
  return 'sent';
};

/**
 * ↻: restart the agent and continue the same session (R-M4-1). Unlike a switch it is allowed while busy (R-M4-4, the
 * escape hatch for a stuck agent; the server interrupts first). It rides the switch phases: the server answers with an
 * empty `replay` and the same session again, and refuses with a `switch` server-error.
 */
export const restartAgent = (): AppThunk<boolean> => (dispatch, getState, { send }) => {
  const st = getState();
  if (st.controls.switching || st.conn.state !== 'open' || !send({ type: 'restart' })) return false;
  clearTimeout(serverRestartTimer);
  dispatch(switchStarted(true));
  return true;
};

/** How long a full restart may wait for the socket to come back before the UI is released. */
export const SERVER_RESTART_TIMEOUT_MS = 30_000;
let serverRestartTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * ↻ menu, "restart the server" (R-M5-1): POST /restart-server; the process exits (75), the launcher relaunches it on the
 * same port and the socket reconnects by itself. It rides the `restarting` switch phases. The phase must NOT end on the
 * connection close (the old socket closes before the new server is up); it ends on the reconnect's replay carrying the
 * session, or, if the server never returns (no supervisor, crash loop), after 30 s with a `restartFail` toast.
 */
export const restartServer = (): AppThunk<Promise<boolean>> => async (dispatch, getState) => {
  const st = getState();
  if (st.controls.switching) return false;
  dispatch(switchStarted(true));
  clearTimeout(serverRestartTimer);
  const giveUp = (msg: string) => {
    clearTimeout(serverRestartTimer);
    if (!getState().controls.restarting) return;
    dispatch(switchCleared());
    toast(t('restartFail'), msg);
  };
  try {
    const r = await fetch('/restart-server', { method: 'POST' });
    if (!r.ok) { giveUp((await r.text().catch(() => '')) || String(r.status)); return false; }
  } catch (e) {
    giveUp(e instanceof Error ? e.message : String(e));
    return false;
  }
  if (getState().controls.restarting) serverRestartTimer = setTimeout(() => giveUp(''), SERVER_RESTART_TIMEOUT_MS);
  return true;
};
