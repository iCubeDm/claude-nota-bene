import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEvent } from '@nota-bene/shared';
import { HistoryArchive } from './archive.ts';
import { AttachmentStore } from './attachments.ts';
import type { AgentBackend, AgentSession } from './agent/types.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { setIdleCompactPref } from './prefs.ts';
import { titleOf } from './sessions.ts';
import { AgentSlot } from './session/agentSlot.ts';
import { CommandKeeper } from './session/commands.ts';
import { archiveCut } from './session/archiveCut.ts';
import { readHistory } from './session/history.ts';
import { SessionIdentity } from './session/identity.ts';
import { idleCompaction } from './session/idleWiring.ts';
import { resolveImages } from './session/images.ts';
import { ModeKeeper } from './session/mode.ts';
import { ModelKeeper } from './session/model.ts';
import type { SessionOptions } from './session/options.ts';
import { PermissionBroker } from './session/permissions.ts';
import { Phase, SwitchError } from './session/phase.ts';
import { SendQueue } from './session/sendQueue.ts';
import { checkTarget } from './session/target.ts';
import { TitleTracker } from './session/title.ts';
import { TurnLedger, activity } from './session/turns.ts';
import type { SessionManager } from './session/types.ts';
import { stateDir } from './state.ts';
import { StatsService } from './stats.ts';

export { SwitchError };
export type { SessionManager };


const CLOSE_TIMEOUT_MS = 5000; // a CLI that does not end its message loop after close() must not hold the switch
const INTERRUPT_TIMEOUT_MS = 2000; // a busy restart's interrupt; a stuck CLI must not hold the restart
const HISTORY_TIMEOUT_MS = 20_000; // a transcript read that hangs must not hold `switching`

/** The command a message line starts with, when it is one the server tracks (the buttons send the plain form; the CLI also takes arguments and the aliases). */
export function trackedCommand(text: string): 'compact' | 'clear' | undefined {
  const m = /^\/(compact|clear|reset|new)(\s|$)/.exec(text);
  return m ? (m[1] === 'compact' ? 'compact' : 'clear') : undefined;
}

/**
 * The façade (R-M7-11): it wires the parts under ./session/ and owns the pump, the switch procedure and the command
 * hand-over. Phase: live/switching/closed. TurnLedger: every send, the turn facts. PermissionBroker: the open asks.
 * TitleTracker: the title. AgentSlot: agent, loop, generation. SessionIdentity: id, root, model, fork, `session`.
 * ModeKeeper: the mode. ModelKeeper: the model and effort. SendQueue: the user's sends in order. See the M7-11 report for the old-flag owners.
 * The one cycle, titles ⇄ who: TitleTracker.onChange → who.announce() (an emit), and who's `title` option reads
 * titles.title (read-only); neither calls back into the other's state changes.
 */
export async function createSessionManager(o: SessionOptions): Promise<SessionManager> {
  const { hub, backend } = o;
  const report = (where: string, e: unknown) => reportError(hub, where, e);
  const attachments = o.attachments ?? new AttachmentStore({ dir: path.join(stateDir(), 'attachments') });
  const titles: TitleTracker = new TitleTracker({
    lookup: async (id, dir) => titleOf(await backend.sessionInfo(id, dir)),
    current: () => ({ id: who.id, dir: who.root, gen: slot.gen }),
    onChange: () => who.announce(),
  });
  // root changes only in a switch
  const who = new SessionIdentity({ root: o.cwd, resume: o.resume, fork: o.fork, title: () => titles.title, emit: (ev) => hub.emit(ev), report });
  const modes = new ModeKeeper({ modes: backend.capabilities.modes, dir: who.root, emit: (ev) => hub.emit(ev, { store: false }), report });
  const models = new ModelKeeper({ dir: who.root, emit: (ev) => hub.emit(ev, { store: false }), report });
  const cmds = new CommandKeeper((ev) => hub.emit(ev, { store: false }));
  const switchListeners: ((id: string | null, o: { restart: boolean }) => void)[] = [];

  const phase = new Phase();
  const turns = new TurnLedger();
  const archive = archiveCut({
    hub, archive: o.archive ?? new HistoryArchive({ dir: path.join(stateDir(), 'history'), report: (e) => report('archive', e) }),
    id: () => who.ownId, inFlight: (id) => turns.inFlight(id), report,
  });
  const permissions = new PermissionBroker({ emit: (ev) => hub.emit(ev) });
  const slot: AgentSlot = new AgentSlot({
    start: (g) => startAgent(g),
    pump,
    onError: report,
    phase: () => phase.kind,
  });
  const queue = new SendQueue({ gen: () => slot.gen, agent: () => slot.ensure(), running: (id) => turns.running(id), isCurrent: (a) => slot.agent === a, interruptMs: o.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS, report, fail: (e, id) => failTurn(e, id) });
  /** A send not yet answered, a waiting permission, or a switch in progress (R-M4-4); `closed` is not part of it. */
  const busy = () => phase.switching || activity(turns, permissions) !== 'idle';
  const stats = new StatsService({
    session: () => (backend.capabilities.usage ? slot.agent : null), // no usage: no meters, nothing asked of the agent
    emit: (s) => hub.emit({ kind: 'stats', stats: s }, { store: false }),
    hasClients: () => hub.clients() > 0,
    onError: (e) => report('stats', e),
  });
  const { idle, state: idleState } = idleCompaction({
    config: o.idle, offInSettings: o.idleOffInSettings, root: () => who.root, capabilities: backend.capabilities,
    // no agent (it died): starting one only to compact, with nobody watching, is not ours to do
    busy: () => phase.kind !== 'live' || slot.agent === null || busy(),
    contextUsed: () => stats.current().context?.used ?? null,
    compact: () => runCommand('compact', true),
  });

  /** a new agent in the current mode, model and effort; its model list is asked for once it is up */
  function startAgent(g: number): AgentSession {
    const a = backend.start({ ...who.startOptions(), permissionMode: modes.mode, ...models.forStart(who.root), ask: permissions.ask(() => slot.gen, g) });
    if (backend.capabilities.models) models.load(a, () => slot.isCurrent(a, g)).catch((e) => { if (g === slot.gen) report('models', e); });
    cmds.load(a, () => slot.isCurrent(a, g)).catch((e) => { if (g === slot.gen) report('commands', e); });
    return a;
  }

  /** The agent's message loop: only the current agent of the current generation reaches the hub. */
  async function pump(a: AgentSession, g: number): Promise<void> {
    try {
      for await (const e of a.messages) {
        if (!slot.isCurrent(a, g)) return;
        onAgent(e);
      }
      if (slot.isCurrent(a, g)) died(a, new Error('agent session ended'));
    } catch (e) {
      if (slot.isCurrent(a, g)) died(a, e);
    }
  }

  /** One event of the current agent. Every kind but `init`, `rate-limit` and `commands` (server-internal) reaches the clients. */
  function onAgent(e: AgentEvent): void {
    switch (e.t) {
      case 'init':
        // the CLI sends init at the start of every turn: act only when something is new
        if (e.mode) modes.adopt(e.mode, who.root);
        if (e.model && backend.capabilities.models) models.adopt(e.model);
        who.init(e);
        return;
      case 'rate-limit':
        stats.onAgent(e);
        return;
      case 'commands':
        cmds.set(e.commands);
        return;
      case 'reset':
        onReset(e);
        return;
      case 'turn-end': {
        const { store, arm } = turns.turnEnd(e);
        hub.emit({ kind: 'agent', e }, store ? {} : { store: false }); // the result that follows a /clear's reset is live only
        stats.onAgent(e);
        titles.afterResult();
        if (arm) idle.turnEnded();
        return;
      }
      case 'cancelled':
        turns.cancelled(e.sendId);
        break;
      case 'compacted':
        // any compaction (manual, auto, idle) disarms; the turn that compacted (a /compact's own result too) does not
        // arm again: the next one waits for a turn after it
        turns.compactBoundary();
        idle.disarm();
        break;
      // `compact-end` (a compaction that ended with no boundary) neither arms nor disarms: the turn's end decides
      default:
        break;
    }
    hub.emit({ kind: 'agent', e });
    if (e.t === 'compacted') archive.cut(); // after the emit: the boundary stays, first, in the history (R-M7-2)
    stats.onAgent(e);
    // the CLI can change the mode itself (plan approval, its own keys): follow it, but only on a real change
    if (e.t === 'mode') modes.adopt(e.mode, who.root);
  }

  /**
   * /clear (or the CLI leaving plan mode with a cleared context): a new conversation under a new id. The feed is
   * emptied (a reload must not bring the old turns back), the new id becomes the current and the resume target, and
   * the id listeners hear it with the old id as `prev`, so the server sends that id's own (empty) comments and
   * never adopts the unsent set. The reset event itself is live only: the web renders its line from it.
   */
  function onReset(e: Extract<AgentEvent, { t: 'reset' }>): void {
    turns.reset();
    hub.reset();
    titles.reset();
    const next = who.reset(e.newId);
    hub.emit({ kind: 'agent', e }, { store: false });
    who.announce();
    stats.onAgent(e);
    if (next) who.hear(next);
  }

  function died(a: AgentSession, e: unknown): void {
    report('agent', e);
    slot.died(a);
    permissions.denyAll();
    hub.emit({ kind: 'agent', e: turns.crashed(e) }); // only the sends the agent had; the queued ones run on the next
  }

  /** the server answers for the agent: the send `id` it could not hand over */
  function failTurn(e: unknown, id: string): void {
    hub.emit({ kind: 'agent', e: turns.failure(e, id) });
  }

  /** The feed of `id` in the root: emptied, then a resumed session's transcript with its `resumed` marker, then the
   * `session` event (with the title). At startup there are no sockets yet. */
  async function load(id: string | null): Promise<void> {
    hub.reset();
    who.forget(); // the history that held the last one is gone: always announce
    if (id) {
      const read = () => backend.history(id, who.root, attachments, (e) => report('attach', e));
      hub.reset(await readHistory({ read, timeoutMs: o.historyTimeoutMs ?? HISTORY_TIMEOUT_MS, report }), { earlier: archive.earlier() });
      hub.emit({ kind: 'resumed', id });
      await titles.load(id, who.root);
    }
    who.announce(); // header gets the root (and a resumed id) before the first turn's init
  }

  // `restart` is the escape hatch for a stuck agent: it is not busy-gated (only another switch blocks it)
  async function switchTo(id: string | null, dir: string, restart: boolean): Promise<void> {
    const working = () => activity(turns, permissions) !== 'idle';
    if (!phase.beginSwitch()) return; // closed: nothing to switch
    let tornDown = false;
    try {
      if (!restart && working()) throw new SwitchError('switch', 'the agent is busy');
      const real = await checkTarget({ backend, root: who.root, id, dir, ownSession: restart });
      // sends are refused while switching, but the old agent may have asked for a permission during the checks
      if (!restart && working()) throw new SwitchError('switch', 'the agent is busy');
      // a busy restart stops the turn first (best effort, capped), so the transcript it resumes ends cleanly
      if (restart && working()) await slot.stopTurn(o.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS);
      tornDown = true;
      // 1. stop everything of the old session; nothing it does later may reach the hub (the slot's generation)
      stats.stop();
      cmds.set([]); // the new project has its own skills; the new agent brings them
      idle.disarm(); // the new session gets compacted only after a turn of its own
      await slot.teardown(o.closeTimeoutMs ?? CLOSE_TIMEOUT_MS, () => permissions.denyAll());
      titles.stop();
      titles.reset();
      turns.clear();
      queue.reset();
      // 2. the new session's state
      const same = who.enter(id, real);
      modes.enter(who.root);
      models.enter(who.root);
      stats.reset();
      // 3. the feed, the header, the mode, the stats; the comments come from the onSwitch listeners
      await load(id);
      modes.ack();
      models.ack();
      hub.emit({ kind: 'idle-compact', state: idleState() }, { store: false }); // a per-project setting: the root may have changed
      hub.emit({ kind: 'stats', stats: stats.current() }, { store: false });
      for (const cb of switchListeners) {
        try { cb(id, { restart: same }); } catch (e) { report('switch', e); }
      }
    } finally {
      phase.endSwitch();
      // after the history replay, so no frame of the new agent can be wiped by it; a close() meanwhile: no agent
      if (tornDown && phase.kind === 'live') {
        try { slot.ensure(); } catch (e) { report('agent', e); }
        stats.start();
      }
    }
  }

  /** `idle`: the server's own /compact after a quiet stretch (the feed shows it as such, not as the user's). */
  function runCommand(name: 'compact' | 'clear', isIdle: boolean): void {
    if (busy()) {
      if (isIdle) return; // nobody asked: no toast
      report('busy', new Error(phase.switching ? 'the session is switching; the command was not sent' : 'the agent is busy; the command was not sent'));
      return;
    }
    if (!isIdle) idle.touch();
    const id = randomUUID();
    const text = `/${name}`;
    const g = slot.gen;
    try {
      const a = slot.ensure();
      hub.emit({ kind: 'user', id, text, ...(isIdle ? { idle: true } : {}) }); // before the agent sees it, as in the prototype
      turns.sent(id, { command: name });
      turns.running(id);
      a.send({ uuid: id, text, priority: 'next' });
    } catch (e) {
      if (g !== slot.gen) return;
      report('send', e);
      failTurn(e, id);
    }
  }

  await load(who.id);
  slot.ensure();
  stats.start();

  return {
    send({ id, text, force, images }) {
      if (phase.switching) return 'switching';
      turns.assertNew(id); // first: a reused id is refused with no side effects
      turns.userTurn(); // a real turn follows: its result is a normal one
      idle.touch();
      slot.ensure();
      const { refs, payload } = resolveImages(attachments, images, (e) => report('attach', e));
      // typed in the composer, /compact and /clear are the buttons' commands: their result never arms idle compaction, a /clear's is live only
      const command = trackedCommand(text);
      turns.sent(id, command ? { command } : {});
      hub.emit({ kind: 'user', id, text, ...(force ? { force: true } : {}), ...(refs.length ? { images: refs } : {}) });
      queue.push({ id, text, force, images: payload }); // handed over in order, after a forced send's interrupt
      return null;
    },
    command: (name) => runCommand(name, false),
    interrupt() {
      const g = slot.gen;
      slot.agent?.interrupt().catch((e) => { if (g === slot.gen) report('interrupt', e); });
    },
    answer: (permissionId, allow) => permissions.answer(permissionId, allow),
    mode: () => modes.mode,
    async setMode(next, id) {
      // mid-switch it is not applied: the answer says the mode as it stands, then the switch announces the new session's
      if (phase.switching) return modes.ack(id);
      const g = slot.gen;
      const dir = who.root;
      try {
        await slot.agent?.setPermissionMode(next); // no agent (it died): nothing to tell, the next one starts in this mode
        if (g === slot.gen) modes.set(next, dir); // a switch meanwhile: this was the old session's
      } catch (e) {
        if (g === slot.gen) report('mode', e);
      }
      modes.ack(id);
    },
    model: () => models.current,
    models: () => models.models,
    commands: () => cmds.commands,
    async setModel(next, id) {
      if (phase.switching) return models.ack(id); // the switch announces the new session's model
      const g = slot.gen;
      try {
        await models.change(slot.agent, next, who.root, () => g === slot.gen);
      } catch (e) {
        if (g === slot.gen) report('model', e);
      }
      models.ack(id);
    },
    info: () => { const i = who.info(); return { id: i.id, root: i.root, title: titles.title, model: i.model }; },
    archiveId: () => who.ownId,
    busy,
    switching: () => phase.switching,
    switch: ({ id, dir }) => switchTo(id, dir, false),
    restart: () => switchTo(who.id, who.root, true),
    activity: () => idle.touch(),
    idleCompact: idleState,
    setIdleCompact(on) {
      try { setIdleCompactPref(who.root, on); } catch (e) { report('prefs', e); }
      hub.emit({ kind: 'idle-compact', state: idleState() }, { store: false });
    },
    onSwitch: (cb) => void switchListeners.push(cb),
    fileSuggestions: (query) => (!backend.capabilities.fileSuggestions ? Promise.resolve([]) : slot.agent ? slot.agent.fileSuggestions(query) : Promise.reject(new Error('no agent'))),
    stopTask: (id) => (slot.agent ? slot.agent.stopTask(id) : Promise.reject(new Error('no agent'))),
    backgroundTask: (call) => (slot.agent ? slot.agent.backgroundTask(call) : Promise.reject(new Error('no agent'))),
    taskOutput: (id) => (slot.agent ? slot.agent.taskOutput(id) : Promise.reject(new Error('no agent'))),
    stats: () => stats.current(),
    clientAttached: () => stats.onAttach(),
    close() {
      phase.close();
      stats.stop();
      idle.stop();
      titles.stop();
      slot.close(() => permissions.denyAll());
    },
    onSessionId: (cb) => who.onId(cb),
  };
}
