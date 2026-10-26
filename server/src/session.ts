import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MODES } from '@nota-bene/shared';
import type { ImageRef, Mode, ServerEvent, Stats } from '@nota-bene/shared';
import { AttachmentStore } from './attachments.ts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, AgentSession, PermissionAsk, SendImage } from './agent/types.ts';
import { stripUserFrameImages } from './agent/transcript.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { prefsKey, readPrefs, setModePref } from './prefs.ts';
import { cwdOf, titleOf } from './sessions.ts';
import { saveSession, stateDir } from './state.ts';
import { StatsService } from './stats.ts';

/**
 * A refused switch or restart. Reported as `where: 'switch'`, also when it was refused for being busy (a turn, a
 * permission or another switch in progress): the client ends its "switching" state on exactly this, never on a `busy`
 * error, which may answer some other socket's send or command (M4-10).
 */
export class SwitchError extends Error {
  readonly where: 'busy' | 'switch';
  constructor(where: 'busy' | 'switch', message: string) {
    super(message);
    this.where = where;
  }
}

export type SessionManager = {
  send(m: { id: string; text: string; force?: boolean; images?: ImageRef[] }): void;
  interrupt(): void;
  answer(permissionId: string, allow: boolean): void;
  mode(): Mode;
  /** Asks the agent, then persists and announces; a refusal is reported and the current mode re-announced. */
  setMode(mode: Mode): Promise<void>;
  info(): { id: string | null; root: string; title: string | null; model: string | null };
  /** A send not yet answered by a result, a waiting permission, or a switch in progress (R-M4-4). */
  busy(): boolean;
  /** True from the start of a switch's checks to the new session's announcement. */
  switching(): boolean;
  /**
   * Closes the agent, moves to `dir` (absolute, an existing directory; for an id, the session's own cwd) and resumes
   * `id` there, or starts a new session for null. Rejects with a SwitchError while busy or for a bad target, before
   * anything is torn down.
   */
  switch(o: { id: string | null; dir: string }): Promise<void>;
  /**
   * switch({ id: current id, dir: root }): the same session resumed by a fresh agent; a fresh start when there is no
   * id yet. Allowed while busy (the stuck-agent escape hatch): it interrupts first (2 s cap); only a switch blocks it.
   */
  restart(): Promise<void>;
  /**
   * `/compact` or `/clear`: shown in the feed as a user event, then sent to the agent as the plain string. Refused
   * (reported as `busy`) while the agent is busy or the session is switching (R-M4-4).
   */
  command(name: 'compact' | 'clear'): void;
  /** Called at the end of a switch, after the session, mode and stats events (the server sends the comments there). */
  onSwitch(cb: (id: string | null, o: { restart: boolean }) => void): void;
  /** The running agent's @ search; rejects when there is no agent (then the caller falls back). */
  fileSuggestions(query: string): Promise<string[]>;
  /** Context, plan limits and cost as last measured (what a new socket gets). */
  stats(): Stats;
  /** Stops the stats timers and closes the agent. Idempotent. */
  close(): void;
  /** Called whenever the session id changes to a real id (first init, or a different id after resume/restart). */
  onSessionId(cb: (id: string, prev: string | null) => void): void;
};

type Msg = {
  type?: string; subtype?: string; session_id?: string; permissionMode?: unknown; model?: unknown;
  is_error?: unknown; user_message_uuid?: unknown; user_message_uuids?: unknown; state?: unknown; command_uuid?: unknown;
};

const isReset = (f: Msg) => f.type === 'conversation_reset' || (f.type === 'system' && f.subtype === 'conversation_reset');

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const CLOSE_TIMEOUT_MS = 5000; // a CLI that does not end its message loop after close() must not hold the switch
const INTERRUPT_TIMEOUT_MS = 2000; // a busy restart's interrupt; a stuck CLI must not hold the restart
const TITLE_THROTTLE_MS = 10_000;
const TITLE_TIMEOUT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

function realOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export async function createSessionManager(o: {
  hub: EventHub; backend: AgentBackend; cwd: string; resume?: string; fork?: boolean; attachments?: AttachmentStore;
  /** how long a switch waits for the old agent's message loop to end (tests shorten it) */
  closeTimeoutMs?: number;
  /** how long a busy restart waits for its interrupt (tests shorten it) */
  interruptTimeoutMs?: number;
}): Promise<SessionManager> {
  const { hub, backend } = o;
  const attachments = o.attachments ?? new AttachmentStore({ dir: path.join(stateDir(), 'attachments') });
  let root = o.cwd; // changes only in a switch
  let sessionId: string | null = o.resume ?? null;
  let title: string | null = null;
  let model: string | null = null;
  let lastSession = ''; // the last `session` event sent, as JSON
  let heard: string | null = o.resume ?? null; // the id the id listeners last heard of
  let saved: string | null = null; // last id written to the registry
  // a fork start: the agent branches off `resume`; until its init names the new id, sessionId is still the SOURCE,
  // which must never be written to the registry
  let forkPending = !!(o.fork && o.resume);
  let mode: Mode = readPrefs().modes[prefsKey(root)] ?? 'auto';
  let agent: AgentSession | null = null;
  let loop: Promise<void> | null = null; // the running agent's message loop
  // Bumped when a session is torn down (switch, close). Everything an agent can trigger later (its messages, its
  // permission asks, a queued send, a mode or title answer) carries the generation it started in and is dropped
  // when that is no longer current, so nothing of the old session reaches the new one's sockets.
  let gen = 0;
  let switching = false;
  let closed = false; // close() is final: a switch that ends after it must not start an agent
  let chain: Promise<void> = Promise.resolve(); // keeps interrupt-then-send ordering across sends
  const pending = new Map<string, (allow: boolean) => void>();
  const waiting = new Set<string>(); // sends no result has answered yet (the web reducer's `waiting`)
  let titleAt = -Infinity;
  let titleTimer: NodeJS.Timeout | null = null;
  const stats = new StatsService({
    session: () => agent,
    emit: (s) => hub.emit({ kind: 'stats', stats: s }, { store: false }),
    onError: (e) => reportError(hub, 'stats', e),
  });
  const idListeners: ((id: string, prev: string | null) => void)[] = [];
  const switchListeners: ((id: string | null, o: { restart: boolean }) => void)[] = [];

  const askFor = (g: number): PermissionAsk => (toolName, input, signal) =>
    new Promise<boolean>((resolve) => {
      if (g !== gen) return resolve(false); // an old agent asking after the switch: denied, never shown
      const id = randomUUID();
      const finish = (allow: boolean) => {
        if (!pending.delete(id)) return;
        signal.removeEventListener('abort', onAbort);
        if (g === gen) hub.emit({ kind: 'permission-done', id, allow });
        resolve(allow);
      };
      const onAbort = () => finish(false);
      pending.set(id, finish);
      signal.addEventListener('abort', onAbort, { once: true });
      hub.emit({ kind: 'permission', id, toolName, input });
      if (signal.aborted) onAbort();
    });

  async function pump(a: AgentSession, g: number): Promise<void> {
    const current = () => g === gen && agent === a;
    try {
      for await (const m of a.messages) {
        if (!current()) return;
        const f = m as Msg;
        if (f.type === 'result') settle(f);
        else if (f.type === 'command_lifecycle' && f.state === 'cancelled' && typeof f.command_uuid === 'string') waiting.delete(f.command_uuid);
        if (isReset(f)) {
          onReset(m, f);
          continue;
        }
        hub.emit({ kind: 'sdk', m: stripUserFrameImages(m) });
        stats.onSdk(m);
        const { type, subtype, session_id, permissionMode } = f;
        // the CLI can change the mode itself (plan approval, its own keys): follow it, but only on a real change
        if (type === 'system' && (subtype === 'init' || subtype === 'status') && (MODES as readonly unknown[]).includes(permissionMode)) {
          adoptMode(permissionMode as Mode);
        }
        // the CLI sends init at the start of every turn: act only when something is new
        if (type === 'system' && subtype === 'init') {
          if (session_id) {
            forkPending = false;
            sessionId = session_id;
            if (saved !== session_id) { saved = session_id; saveSession(root, session_id); }
          }
          if (typeof f.model === 'string' && f.model) model = f.model;
          emitSession();
          if (session_id) heardId(session_id);
        }
        if (type === 'result') scheduleTitle();
      }
      if (current()) died(a, new Error('agent session ended'));
    } catch (e) {
      if (current()) died(a, e);
    }
  }

  /**
   * /clear (or the CLI leaving plan mode with a cleared context): a new conversation under a new id. The feed is
   * emptied (a reload must not bring the old turns back), the new id becomes the current and the resume target, and
   * the id listeners hear it with the old id as `prev`, so the server sends that id's own (empty) comments and
   * never adopts the unsent set. The reset frame itself is live only: the web renders its line from it.
   */
  function onReset(m: SDKMessage, f: Msg & { new_conversation_id?: unknown }): void {
    waiting.clear(); // the CLI answers a /clear with no result
    hub.reset();
    lastSession = '';
    title = null;
    titleAt = -Infinity;
    const next = typeof f.new_conversation_id === 'string' && SESSION_ID.test(f.new_conversation_id) ? f.new_conversation_id : null;
    if (next) {
      forkPending = false;
      sessionId = next;
      saved = next;
      try { saveSession(root, next); } catch (e) { reportError(hub, 'session', e); }
    }
    hub.emit({ kind: 'sdk', m: stripUserFrameImages(m) }, { store: false });
    emitSession();
    stats.onSdk(m);
    if (next) heardId(next);
  }

  /** Mirrors the web reducer: a result answers the sends it names; one naming none answers all if it is an error. */
  function settle(m: Msg): void {
    const answered = Array.isArray(m.user_message_uuids) ? (m.user_message_uuids as unknown[])
      : typeof m.user_message_uuid === 'string' ? [m.user_message_uuid] : null;
    if (answered) for (const id of answered) waiting.delete(id as string);
    else if (m.is_error === true) waiting.clear();
  }

  function adoptMode(next: Mode): void {
    if (next === mode) return;
    mode = next;
    try { setModePref(root, next); } catch (e) { reportError(hub, 'mode', e); }
    hub.emit({ kind: 'mode', mode }, { store: false });
  }

  /** Sends `session` when any of its fields changed since the last one. */
  function emitSession(): void {
    const ev = { kind: 'session' as const, id: sessionId, root, title, model };
    const json = JSON.stringify(ev);
    if (json === lastSession) return;
    lastSession = json;
    hub.emit(ev);
  }

  function heardId(id: string): void {
    if (id === heard) return;
    const prev = heard;
    heard = id;
    for (const cb of idListeners) {
      try { cb(id, prev); } catch (e) { reportError(hub, 'session-id', e); }
    }
  }

  /** The title as the CLI lists it; undefined when the lookup failed (the caller keeps what it had). */
  async function fetchTitle(id: string, dir: string): Promise<string | null | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const info = await Promise.race([
        backend.sessionInfo(id, dir),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('session info timeout')), TITLE_TIMEOUT_MS); }),
      ]);
      return titleOf(info);
    } catch (e) {
      console.error('[title]', e); // cosmetic and retried after the next result: not a toast
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshTitle(): Promise<void> {
    const g = gen;
    const id = sessionId;
    if (!id) return;
    titleAt = Date.now();
    const t = await fetchTitle(id, root);
    if (g !== gen || id !== sessionId || t === undefined || t === title) return;
    title = t;
    emitSession();
  }

  /** After a result: at most one lookup per 10 s, the last result's lookup trailing. */
  function scheduleTitle(): void {
    if (titleTimer) return;
    const wait = titleAt + TITLE_THROTTLE_MS - Date.now();
    if (wait <= 0) {
      void refreshTitle();
      return;
    }
    titleTimer = setTimeout(() => { titleTimer = null; void refreshTitle(); }, wait);
    titleTimer.unref();
  }

  function died(a: AgentSession, e: unknown): void {
    reportError(hub, 'agent', e);
    agent = null;
    loop = null;
    try { a.close(); } catch (err) { reportError(hub, 'agent-close', err); }
    for (const finish of [...pending.values()]) finish(false);
    emitErrorResult(e);
  }

  // shaped like SDKResultError: the text goes in errors[]; no aborted terminal_reason, so it shows as an error.
  // With `answers` it names the send it stands in for (user_message_uuid(s)); without, it answers every waiting send.
  function emitErrorResult(e: unknown, answers?: string): void {
    const message = e instanceof Error ? e.message : String(e);
    const m = {
      type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 0, errors: [message],
      ...(answers ? { user_message_uuid: answers, user_message_uuids: [answers] } : {}),
    };
    settle(m);
    hub.emit({ kind: 'sdk', m: m as unknown as SDKMessage });
  }

  function ensureAgent(): AgentSession {
    if (agent) return agent;
    // mid-switch nothing may start an agent: the switch starts the new one after the replay
    if (switching) throw new Error('the session is switching');
    const g = gen;
    const a = backend.start({ cwd: root, permissionMode: mode, ...(sessionId ? { resume: sessionId } : {}), ...(forkPending ? { fork: true } : {}), ask: askFor(g) });
    agent = a;
    loop = pump(a, g);
    return a;
  }

  /**
   * The feed of `id` in `root`: every socket's feed is emptied, then a resumed session's transcript is replayed
   * with its `resumed` marker; then the `session` event (with the title). At startup there are no sockets yet.
   */
  async function load(id: string | null): Promise<void> {
    hub.reset();
    lastSession = ''; // the history that held the last one is gone: always announce
    if (id) {
      let history: ServerEvent[] = [];
      try {
        history = await backend.history(id, root, attachments, (e) => reportError(hub, 'attach', e));
      } catch (e) {
        reportError(hub, 'history', e); // an unreadable transcript must not stop the server: start with an empty feed
      }
      hub.reset(history);
      hub.emit({ kind: 'resumed', id });
      titleAt = Date.now();
      title = (await fetchTitle(id, root)) ?? null;
    }
    emitSession(); // header gets the root (and a resumed id) before the first turn's init
  }

  /** Throws a SwitchError for a target that must not be opened; returns the realpath of `dir`. */
  async function checkTarget(id: string | null, dir: string, ownSession: boolean): Promise<string> {
    let real: string;
    try {
      if (!path.isAbsolute(dir)) throw new Error('relative');
      real = await fs.promises.realpath(dir); // the promises realpath is the native one (case, firmlinks), like realOr
      if (!(await fs.promises.stat(real)).isDirectory()) throw new Error('not a directory');
      await fs.promises.access(real, fs.constants.R_OK | fs.constants.X_OK);
    } catch {
      throw new SwitchError('switch', `not an existing, readable directory: ${dir}`);
    }
    if (ownSession) return real;
    if (id === null) {
      // a new session may only open where a session already lives (or here): a local client must not be able to
      // re-root /file at / or ~
      if (real === realOr(root)) return real;
      let list: Awaited<ReturnType<AgentBackend['listSessions']>>;
      try {
        list = await backend.listSessions();
      } catch (e) {
        throw new SwitchError('switch', `cannot list sessions: ${e instanceof Error ? e.message : String(e)}`);
      }
      const known = new Set<string>();
      for (const x of list) {
        const cwd = x.cwd || cwdOf(x.sessionId);
        if (cwd && !known.has(cwd)) known.add(cwd);
      }
      for (const cwd of known) if (realOr(cwd) === real) return real;
      throw new SwitchError('switch', `no session lives in ${real}`);
    }
    if (!SESSION_ID.test(id)) throw new SwitchError('switch', `invalid session id: ${id}`);
    // the client sends the session's own cwd: a mismatch is a bug or a stale list, never something to guess around
    let info: Awaited<ReturnType<AgentBackend['sessionInfo']>>;
    try {
      info = await backend.sessionInfo(id, real);
    } catch (e) {
      throw new SwitchError('switch', `cannot read session ${id.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const cwd = info ? info.cwd ?? cwdOf(id) : null;
    if (!info || (cwd !== null && realOr(cwd) !== real)) throw new SwitchError('switch', `session ${id.slice(0, 8)} does not belong to ${real}`);
    return real;
  }

  // `restart` is the escape hatch for a stuck agent: it is not busy-gated (only another switch blocks it)
  async function switchTo(id: string | null, dir: string, restart: boolean): Promise<void> {
    if (switching) throw new SwitchError('switch', 'a switch is already in progress');
    if (!restart && (waiting.size > 0 || pending.size > 0)) throw new SwitchError('switch', 'the agent is busy');
    switching = true;
    let tornDown = false;
    try {
      const real = await checkTarget(id, dir, restart);
      // sends are refused while switching, but the old agent may have asked for a permission during the checks
      if (!restart && (waiting.size > 0 || pending.size > 0)) throw new SwitchError('switch', 'the agent is busy');
      // a busy restart stops the turn first (best effort, capped), so the transcript it resumes ends cleanly
      if (restart && agent && (waiting.size > 0 || pending.size > 0)) {
        const a = agent;
        let raced = false; // lost the race: the late rejection (the CLI's "Query closed" on close) is no news
        const stopped = a.interrupt().catch((e) => { if (!raced) reportError(hub, 'interrupt', e); });
        await Promise.race([stopped, sleep(o.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS)]);
        raced = true;
      }
      tornDown = true;
      // 1. stop everything of the old session; nothing it does later may reach the hub (gen)
      stats.stop();
      gen++;
      const old = agent;
      const oldLoop = loop;
      agent = null;
      loop = null;
      for (const finish of [...pending.values()]) finish(false);
      try { old?.close(); } catch (e) { reportError(hub, 'agent-close', e); }
      if (oldLoop) await Promise.race([oldLoop, sleep(o.closeTimeoutMs ?? CLOSE_TIMEOUT_MS)]);
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = null;
      titleAt = -Infinity;
      waiting.clear();
      chain = Promise.resolve();
      // 2. the new session's state
      const same = id === sessionId && real === realOr(root);
      root = real;
      // a restart before the fork's first init keeps forking; any other target ends the pending fork
      if (!(forkPending && id === sessionId)) forkPending = false;
      sessionId = id;
      saved = forkPending ? null : id;
      heard = id; // the server sends this id's comments in onSwitch, not through the id listeners
      title = null;
      model = null;
      mode = readPrefs().modes[prefsKey(root)] ?? 'auto';
      stats.reset();
      if (id && !forkPending) {
        try { saveSession(root, id); } catch (e) { reportError(hub, 'session', e); }
      }
      // 3. the feed, the header, the mode, the stats; the comments come from the onSwitch listeners
      await load(id);
      hub.emit({ kind: 'mode', mode }, { store: false });
      hub.emit({ kind: 'stats', stats: stats.current() }, { store: false });
      for (const cb of switchListeners) {
        try { cb(id, { restart: same }); } catch (e) { reportError(hub, 'switch', e); }
      }
    } finally {
      switching = false;
      // after the history replay, so no frame of the new agent can be wiped by it
      if (tornDown && !closed) {
        try { ensureAgent(); } catch (e) { reportError(hub, 'agent', e); }
        stats.start();
      }
    }
  }

  await load(sessionId);
  ensureAgent();
  stats.start();

  return {
    send({ id, text, force, images }) {
      if (switching) {
        reportError(hub, 'busy', new Error('the session is switching; the message was not sent'));
        return;
      }
      ensureAgent();
      // resolve refs first: an unknown id is reported, the text and the other images still go out
      const refs: ImageRef[] = [];
      const payload: SendImage[] = [];
      for (const ref of images ?? []) {
        try {
          const found = attachments.get(ref.id);
          if (!found) throw new Error(`unknown attachment ${ref.id}`);
          refs.push({ ...ref, mediaType: found.mediaType });
          payload.push({ mediaType: found.mediaType, data: found.bytes.toString('base64'), label: ref.label });
        } catch (e) {
          reportError(hub, 'attach', e);
        }
      }
      hub.emit({ kind: 'user', id, text, ...(force ? { force: true } : {}), ...(refs.length ? { images: refs } : {}) });
      waiting.add(id);
      const g = gen;
      chain = chain.then(async () => {
        // queued before a switch, or a switch began while it waited: it belongs to the old session (checked after
        // every await; a stale interrupt rejection must neither toast nor start an agent)
        if (g !== gen) return;
        try {
          // resolve the agent when this runs: a crash while queued restarts it
          if (force) await ensureAgent().interrupt().catch((e) => { if (g === gen) reportError(hub, 'interrupt', e); }); // no-op when idle
          if (g !== gen) return;
          ensureAgent().send({ uuid: id, text, priority: force ? 'now' : 'next', ...(payload.length ? { images: payload } : {}) });
        } catch (e) {
          if (g !== gen) return;
          reportError(hub, 'send', e);
          emitErrorResult(e, id); // the user event is already out: answer it or the feed waits forever
        }
      });
    },
    command(name) {
      if (switching || waiting.size > 0 || pending.size > 0) {
        reportError(hub, 'busy', new Error(switching ? 'the session is switching; the command was not sent' : 'the agent is busy; the command was not sent'));
        return;
      }
      const id = randomUUID();
      const text = `/${name}`;
      const g = gen;
      try {
        const a = ensureAgent();
        hub.emit({ kind: 'user', id, text }); // before the agent sees it, as in the prototype
        waiting.add(id);
        a.send({ uuid: id, text, priority: 'next' });
      } catch (e) {
        if (g !== gen) return;
        reportError(hub, 'send', e);
        emitErrorResult(e, id);
      }
    },
    interrupt() {
      const g = gen;
      agent?.interrupt().catch((e) => { if (g === gen) reportError(hub, 'interrupt', e); });
    },
    answer(permissionId, allow) {
      pending.get(permissionId)?.(allow);
    },
    mode: () => mode,
    async setMode(next) {
      if (switching) return; // the switch announces the new session's mode; the client's optimistic pill follows it
      const g = gen;
      const dir = root;
      try {
        // no agent (it died): nothing to tell, the next one starts in this mode
        await agent?.setPermissionMode(next);
        if (g !== gen) return;
        // the CLI's own status frame may have got here first and already announced it
        if (mode !== next) {
          mode = next;
          setModePref(dir, next);
          hub.emit({ kind: 'mode', mode }, { store: false });
        }
        return;
      } catch (e) {
        if (g !== gen) return;
        reportError(hub, 'mode', e);
      }
      hub.emit({ kind: 'mode', mode }, { store: false });
    },
    info: () => ({ id: sessionId, root, title, model }),
    busy: () => switching || waiting.size > 0 || pending.size > 0,
    switching: () => switching,
    switch: ({ id, dir }) => switchTo(id, dir, false),
    restart: () => switchTo(sessionId, root, true),
    onSwitch(cb) {
      switchListeners.push(cb);
    },
    fileSuggestions: (query) => (agent ? agent.fileSuggestions(query) : Promise.reject(new Error('no agent'))),
    stats: () => stats.current(),
    close() {
      closed = true;
      gen++;
      stats.stop();
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = null;
      const a = agent;
      agent = null; // the pump then ends quietly instead of reporting a dead agent
      loop = null;
      for (const finish of [...pending.values()]) finish(false);
      try { a?.close(); } catch (e) { reportError(hub, 'agent-close', e); }
    },
    onSessionId(cb) {
      idListeners.push(cb);
    },
  };
}
