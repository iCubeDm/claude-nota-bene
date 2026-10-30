import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, PROTOCOL, TAKEN_OVER_CODE } from '@nota-bene/shared';
import type { ClientMessage, Comment } from '@nota-bene/shared';
import type { AgentBackend } from './agent/types.ts';
import { guard, reportError } from './errors.ts';
import { HistoryArchive, historyRoutes } from './archive.ts';
import { subagentRoutes } from './subagent.ts';
import { taskOutputRoutes } from './taskOutput.ts';
import { AttachmentStore, attachmentRoutes } from './attachments.ts';
import { MarkFiles, markRoutes } from './marks.ts';
import { CommentStore } from './comments.ts';
import { EventHub } from './hub.ts';
import { complete, fileRoutes } from './fileRoutes.ts';
import { BlendConverter } from './blend.ts';
import { readPrefs } from './prefs.ts';
import { httpHandler, isAllowedHost } from './http.ts';
import { SwitchError, createSessionManager } from './session.ts';
import type { IdleConfig } from './idle.ts';
import { listSessionsView } from './sessions.ts';
import { codeChecker } from './codeStamp.ts';
import { stateDir } from './state.ts';
import { registerWindow } from './windows.ts';
import { controlToken, systemRoutes } from './system.ts';
import { CHALLENGE_RE, KEY_PROTOCOL, accessToken, authenticated, isNonce, keyCredential, loginCredential, newNonce, proofFor, sameSecret, sessionCookie } from './auth.ts';

/** how long a newcomer waits for the owner to close before it is told `occupied` (R-M7-6) */
export const TAKEOVER_GRACE_MS = 700;
/** ping period for the owner socket (R-M7-7) */
export const HEARTBEAT_MS = 30_000;

// Process-wide handlers are registered once; each running server's hub is in this set.
const hubs = new Set<EventHub>();
let handlersInstalled = false;

function installProcessHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const report = (e: unknown) => {
    if (hubs.size === 0) console.error('[server]', e);
    for (const h of hubs) reportError(h, 'server', e);
  };
  process.on('uncaughtException', report);
  process.on('unhandledRejection', report);
}

export async function startServer(o: {
  cwd: string;
  port: number;
  backend: AgentBackend;
  resume?: string;
  fork?: boolean;
  /** called by POST /restart-server and /control/stop (tests stub it) */
  exit?: (code: number) => void;
  /** the checkout the server runs from (Settings → About's version); default: two levels above this file */
  repoDir?: string;
  webDist: string;
  /** the experimental 3D model viewer (/model, Blender); default: env NOTA_BENE_EXPERIMENTAL_3D=1 */
  experimental3d?: boolean;
  allowedOrigins?: string[];
  /** idle compaction timing and the settings.json check (tests shorten / stub them) */
  idle?: IdleConfig;
  idleOffInSettings?: () => boolean;
  /** the `! cmd` runner's timing and environment (tests shorten the timeout and the kill delay) */
  shell?: { timeoutMs?: number; killMs?: number; env?: () => NodeJS.ProcessEnv };
  /**
   * TEST ONLY: serve without the access token. The default, and the only thing main.ts and the launcher ever do, is auth
   * on (see auth.ts). There is deliberately no CLI flag or env var for this.
   */
  insecureNoAuth?: boolean;
  /** this launch's nonce (public; auth.ts): the launcher makes it so a relaunch keeps it. Default: a fresh one */
  nonce?: string;
  /** one tab at a time (R-M7-5); default true. Tests that need several live sockets pass false */
  oneTab?: boolean;
  /** tests shorten the reload grace (R-M7-6) and the heartbeat (R-M7-7) */
  takeoverGraceMs?: number;
  heartbeatMs?: number;
}): Promise<{ url: string; close(): Promise<void> }> {
  const hub = new EventHub();
  installProcessHandlers();
  hubs.add(hub);
  try {
    // the secrets first: a refused one (loose mode, foreign owner, ...) must stop the start before the agent is spawned
    // the access token: read once at start (a rotated file takes effect at the next start). Auth is on unless a test says no
    const token = o.insecureNoAuth ? null : accessToken();
    // made at start, never by a request: an unauthenticated /control/* must not be able to create the file
    const control = controlToken();
    const attachments = new AttachmentStore({ dir: path.join(stateDir(), 'attachments') });
    const archive = new HistoryArchive({ dir: path.join(stateDir(), 'history'), report: (e) => reportError(hub, 'archive', e) });
    const manager = await createSessionManager({
      hub,
      attachments,
      archive,
      backend: o.backend,
      cwd: o.cwd,
      ...(o.resume ? { resume: o.resume } : {}),
      ...(o.resume && o.fork && o.backend.capabilities.fork ? { fork: true } : {}),
      ...(o.idle ? { idle: o.idle } : {}),
      ...(o.idleOffInSettings ? { idleOffInSettings: o.idleOffInSettings } : {}),
      ...(o.shell ? { shell: o.shell } : {}),
    });
    const store = new CommentStore({ dir: path.join(stateDir(), 'comments') });
    // comments are live state, not history: never stored in the replay, a new socket gets the set directly
    const currentComments = () => store.get(manager.info().id);
    const broadcastComments = (items: Comment[]) => hub.emit({ kind: 'comments', items }, { store: false });
    manager.onSessionId((id, prev) => {
      if (prev === null) store.adopt(id);
      broadcastComments(store.get(id));
    });
    manager.onSwitch((id, { restart }) => {
      // the unsent set of a new session (in memory, no id yet) stays behind: it must not be adopted by another
      // session. A restart keeps the same session (and root), so it keeps the set too
      if (!restart) store.set(null, []);
      broadcastComments(store.get(id));
    });
    // supervised = our launcher is still our parent: an orphan (launcher killed) must not offer a restart nobody catches
    const supervised = () => process.env.NOTA_BENE_SUPERVISED === '1'
      && process.ppid === Number(process.env.NOTA_BENE_LAUNCHER_PID);
    const codeChanged = codeChecker({ repoDir: o.repoDir ?? path.resolve(import.meta.dirname, '..', '..') });
    const nonce = o.nonce !== undefined && isNonce(o.nonce) ? o.nonce : newNonce();
    const authorize = token === null ? undefined : (req: http.IncomingMessage, needKey: boolean) => authenticated(req.headers, token, ownPort, nonce, needKey);
    const allowedHosts: string[] = []; // filled after listen, once the port is known
    const allowedOrigins: string[] = [...(o.allowedOrigins ?? [])];
    // the one source of the project root: a switch changes it, so every route reads it per request
    const root = () => manager.info().root;
    let ownPort = 0; // set after listen
    // the exit after a reply (restart-server 75, stop 0): close what can be closed, but never hang on it
    let exiting = false;
    const exitWith = (code: number) => {
      if (exiting) return; // the first exit wins
      exiting = true;
      void Promise.race([close(), new Promise<void>((r) => setTimeout(r, 2000))]).then(() => {
        setTimeout(() => (o.exit ?? process.exit)(code), 100);
      });
    };
    // experimental 3D is off unless asked for: no converter means /model is a plain 404 and Blender is never looked up
    const model3d = o.experimental3d ?? process.env.NOTA_BENE_EXPERIMENTAL_3D === '1';
    const blend = model3d ? new BlendConverter({ stateDir }) : undefined;
    const marks = new MarkFiles({ root, stateDir });
    const sessionsRoute: http.RequestListener = (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const { id } = manager.info();
      listSessionsView({ backend: o.backend, current: id, root: root() }).then(
        (view) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(view));
        },
        (e) => {
          reportError(hub, 'sessions', e);
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(e instanceof Error ? e.message : String(e));
        },
      );
    };
    // POST /auth {token}: the page's one-time login (the token came in the URL fragment, which never reaches a server). Only
    // reached with one of our own Origins (http.ts refuses the other POSTs), so a foreign page cannot even try
    const authRoute: http.RequestListener = (req, res) => {
      const plain = (status: number, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
        res.end(body);
      };
      if (req.method !== 'POST') return plain(405, 'method not allowed', { allow: 'POST' });
      let body = '';
      let tooBig = false;
      req.on('data', (d: Buffer) => {
        body += d;
        if (body.length > 1024) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) return;
        let given: unknown;
        try {
          given = (JSON.parse(body) as { login?: unknown }).login;
        } catch {
          return plain(400, 'bad request');
        }
        if (token === null) return plain(200, '{"ok":true}', { 'content-type': 'application/json; charset=utf-8' });
        // the login value of THIS launch and port, never the raw token: a URL that leaked is good until the launcher exits
        if (typeof given !== 'string' || !sameSecret(given, loginCredential(token, ownPort, nonce))) return plain(401, 'unauthorized');
        plain(200, JSON.stringify({ ok: true, key: keyCredential(token, ownPort, nonce) }), { 'content-type': 'application/json; charset=utf-8', 'set-cookie': sessionCookie(token, ownPort, nonce), 'cache-control': 'no-store' });
      });
    };
    // GET /hello?c=<hex>: the one thing a helper may ask before it trusts a port. Answers only the proof that this server holds the
    // token for the port it is bound to and the given challenge: no root, no state, nothing to replay (the port is in the proof)
    const helloRoute: http.RequestListener = (req, res) => {
      const plain = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      };
      if (req.method !== 'GET') return plain(405, 'method not allowed');
      const c = new URL(req.url ?? '/', 'http://x').searchParams.get('c') ?? '';
      if (token === null || !CHALLENGE_RE.test(c)) return plain(400, 'bad request');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ proof: proofFor(token, ownPort, nonce, c), n: nonce }));
    };
    const server = http.createServer(httpHandler({
      hub,
      open: { '/auth': authRoute, '/hello': helloRoute },
      ...(authorize ? { authorize } : {}),
      allowedHosts,
      allowedOrigins,
      extra: {
        ...fileRoutes({ root, hub, complete: (q) => complete({ session: manager, root: root() }, q), blend }),
        ...attachmentRoutes(attachments, hub),
        // only the current conversation's archive: a page of another one (before a switch or a /clear) gets 409
        ...historyRoutes(archive, () => manager.archiveId(), hub),
        // a subagent's conversation (protocol 7); same rule: only the current conversation's
        ...subagentRoutes({ backend: o.backend, attachments, hub, current: () => manager.archiveId(), root }),
        // a shell task's output tail (protocol 8)
        ...taskOutputRoutes({ hub, current: () => manager.archiveId(), taskOutput: (id) => manager.taskOutput(id) }),
        ...markRoutes(marks, hub, {
          isSent: (id) => store.get(manager.info().id).some((c) => c.id === id && c.status === 'sent'),
        }),
        '/sessions': sessionsRoute,
        '/restart-server': (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
            res.end('method not allowed');
            return;
          }
          if (!supervised() || exiting) {
            res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(exiting ? 'exiting' : 'not supervised');
            return;
          }
          // answer first: the exit must not cut the reply; 75 tells the launcher to relaunch with --continue
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":true}', () => exitWith(75));
        },
        ...systemRoutes({
          hub, root, port: () => ownPort, repoDir: o.repoDir ?? path.resolve(import.meta.dirname, '..', '..'),
          control: {
            supervised,
            exiting: () => exiting,
            restartAgent: () => void manager.restart().catch(switchFailed),
            restartServer: () => exitWith(75),
            stop: () => exitWith(0), // the launcher treats 0 as "stop" and unregisters the window
          },
        }),
      },
      webDist: o.webDist,
      controlToken: () => control,
      info: () => {
        const { id, root, title, model } = manager.info();
        // busy and clients: for another window's Settings → Windows
        return { root, session: id, title, model, supervised: supervised(), codeChanged: codeChanged(), busy: manager.busy(), clients: hub.clients(), blender: blend?.available() ?? false };
      },
    }));
    const switchFailed = (e: unknown) => reportError(hub, e instanceof SwitchError ? e.where : 'switch', e);
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      // the page's key travels as the `nb.<key>` subprotocol (never in the URL); echo it or the browser drops the socket
      handleProtocols: (protocols) => [...protocols].find((p) => p.startsWith(KEY_PROTOCOL)) ?? false,
      verifyClient: ({ req }, done) => {
        const origin = req.headers.origin;
        const ok = isAllowedHost(req.headers.host, allowedHosts)
          && (origin === undefined || allowedOrigins.includes(origin));
        // an unset Origin (a script, a helper) is let in only with valid auth, and so is every browser page
        if (!ok) done(false, 403, 'forbidden');
        else if (authorize && !authorize(req, true)) done(false, 401, 'unauthorized');
        else done(true);
      },
    });
    // the wss re-emits the http server's errors; unhandled, a listen error (EADDRINUSE) would throw out of the
    // server's emit before the listen promise below could reject. The listen promise reports it
    wss.on('error', () => {});

    // a client message the agent's capabilities forbid: a `server-error` (as the other refusals that are no `send`);
    // the web hides these controls, so this only fires for a stale page or a hand-made client
    const caps = o.backend.capabilities;
    const refuse = (what: string) => reportError(hub, 'capability', new Error(`${what}: the agent does not support it`));

    const oneTab = o.oneTab ?? true;
    const graceMs = o.takeoverGraceMs ?? TAKEOVER_GRACE_MS;
    // the owner socket (R-M7-5); only used with oneTab. `alive`: false while a ping waits for its pong
    let owner: { ws: WebSocket; alive: boolean; tab: string | null } | null = null;
    const heartbeat = oneTab
      ? setInterval(() => {
        if (!owner) return;
        if (!owner.alive) { owner.ws.terminate(); return; } // the previous ping got no pong (R-M7-7)
        owner.alive = false;
        try { owner.ws.ping(); } catch { /* socket gone: its close handler follows */ }
      }, o.heartbeatMs ?? HEARTBEAT_MS)
      : null;
    heartbeat?.unref();

    // the hello every socket gets, owner or not
    const sendHello = (ws: WebSocket) => {
      try {
        const lang = readPrefs().lang; // the user's UI language, shared by every window; absent until one is chosen
        ws.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL, capabilities: { ...caps, model3d }, ...(lang ? { lang } : {}) }));
      } catch (e) {
        reportError(hub, 'hello', e);
      }
    };

    // the owner's wiring: replay (via the hub), state frames, hello. Returns nothing; the message handler is shared
    const attachOwner = (ws: WebSocket, tab: string | null) => {
      const hubDetach = hub.attach({ send: (d) => ws.send(d), buffered: () => ws.bufferedAmount });
      let detached = false;
      const detach = () => { if (!detached) { detached = true; hubDetach(); } };
      detachers.set(ws, detach);
      if (oneTab) {
        const me = { ws, alive: true, tab };
        owner = me;
        ws.on('pong', () => { me.alive = true; });
      }
      manager.clientAttached();
      try {
        ws.send(JSON.stringify({ kind: 'comments', items: currentComments() }));
      } catch (e) {
        reportError(hub, 'comments', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'mode', mode: manager.mode() }));
      } catch (e) {
        reportError(hub, 'mode', e);
      }
      // a reload shows the model pill at once: the list and the current choice go with the other state
      try {
        const { model, effort } = manager.model();
        ws.send(JSON.stringify({ kind: 'models', models: manager.models() }));
        ws.send(JSON.stringify({ kind: 'model', model, ...(effort && { effort }) }));
      } catch (e) {
        reportError(hub, 'model', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'commands', commands: manager.commands() }));
      } catch (e) {
        reportError(hub, 'commands', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'idle-compact', state: manager.idleCompact() }));
      } catch (e) {
        reportError(hub, 'idle-compact', e);
      }
      try {
        ws.send(JSON.stringify({ kind: 'stats', stats: manager.stats() }));
      } catch (e) {
        reportError(hub, 'stats', e);
      }
      // a `! cmd` run in progress: the replay holds its start, this brings the output printed so far (live chunks follow)
      try {
        const snap = manager.shellSnapshot();
        if (snap) ws.send(JSON.stringify({ kind: 'shell-out', id: snap.id, text: snap.text, truncated: snap.truncated }));
      } catch (e) {
        reportError(hub, 'shell', e);
      }
      // what this server understands (see PROTOCOL); last, so the state above keeps its order
      sendHello(ws);
      ws.on('close', () => {
        detach();
        if (owner?.ws === ws) owner = null;
        ownerGone.emit('gone');
      });
    };
    const detachers = new WeakMap<WebSocket, () => void>();
    const ownerGone = new EventEmitter();

    // the owner's messages
    const handleOwner = (ws: WebSocket, msg: ClientMessage) => {
        switch (msg.type) {
          case 'send':
            {
              // before markSent: a refused send must not flip its comments to sent. Only the asking socket hears
              // of it (not stored, not broadcast)
              const why = manager.refusal(msg.text);
              if (why) {
                ws.send(JSON.stringify({ kind: 'send-refused', id: msg.id, reason: why }));
                break;
              }
            }
            if (msg.commentIds?.length) {
              // before the agent call: the UI flips to sent even if the agent later fails
              try {
                broadcastComments(store.markSent(manager.info().id, msg.commentIds, msg.id));
              } catch (e) {
                reportError(hub, 'comments', e); // the message itself must still go out
              }
            }
            manager.send({ id: msg.id, text: msg.text, ...(msg.force ? { force: true } : {}), ...(msg.images?.length ? { images: msg.images } : {}) });
            break;
          case 'comments':
            // R14: a set in flight across a switch (or a /clear) must not land in the session that replaced it
            if (manager.switching() || msg.sessionId !== manager.info().id) {
              reportError(hub, 'comments', new Error('stale session'));
              break;
            }
            {
              const id = manager.info().id;
              let prev: Comment[];
              let merged: Comment[];
              try {
                prev = store.get(id);
                merged = store.merge(id, msg.items);
                broadcastComments(merged);
              } catch (e) {
                reportError(hub, 'comments', e); // nothing stored, nothing broadcast; the socket stays up
                break;
              }
              try {
                marks.sync(prev, merged); // a deleted media comment takes its frame/layer files along
              } catch (e) {
                reportError(hub, 'marks', e); // the merge stands
              }
            }
            break;
          case 'mode':
            if (!caps.modes.includes(msg.mode)) {
              refuse(`mode ${msg.mode}`);
              // the sender still waits for its ack (the pill went optimistic): answer with the mode as it stands
              hub.emit({ kind: 'mode', mode: manager.mode(), ...(msg.id && { ack: msg.id }) }, { store: false });
              break;
            }
            void manager.setMode(msg.mode, msg.id);
            break;
          case 'model':
            if (!caps.models) {
              refuse('model');
              // the sender still waits for its ack: answer with the model as it stands
              const cur = manager.model();
              hub.emit({ kind: 'model', model: cur.model, ...(cur.effort && { effort: cur.effort }), ...(msg.id && { ack: msg.id }) }, { store: false });
              break;
            }
            void manager.setModel({ model: msg.model, ...(msg.effort && { effort: msg.effort }) }, msg.id);
            break;
          case 'interrupt':
            manager.interrupt();
            break;
          case 'permission':
            // msg.input is deliberately ignored: a client must never rewrite the input of an approved tool call
            // (the WS also accepts origin-less connections). The agent gets the ORIGINAL input back, as in the prototype.
            manager.answer(msg.id, msg.allow);
            break;
          case 'command':
            if (!caps[msg.name]) return refuse(`command ${msg.name}`);
            manager.command(msg.name);
            break;
          case 'switch':
            manager.switch({ id: msg.id, dir: msg.dir }).catch(switchFailed);
            break;
          case 'activity':
            manager.activity();
            break;
          case 'task-stop':
            manager.stopTask(msg.id).catch((e) => reportError(hub, 'task', e));
            break;
          case 'task-background':
            // false: the call is not a foreground task any more (it ended, or went to the background already)
            manager.backgroundTask(msg.toolUseId).then(
              (moved) => { if (!moved) reportError(hub, 'task', new Error('nothing to move to the background: the task is not running in the foreground')); },
              (e) => reportError(hub, 'task', e),
            );
            break;
          case 'shell-run': {
            // only the asking socket hears of a refusal (not stored): the page puts the draft back
            const why = manager.shellRun(msg.id, msg.cmd);
            if (why === 'running' || why === 'switching') ws.send(JSON.stringify({ kind: 'shell-refused', id: msg.id, reason: why }));
            break;
          }
          case 'shell-stop':
            manager.shellStop(msg.id);
            break;
          case 'idle-compact':
            if (!(caps.idleCompact && caps.compact)) return refuse('idle-compact');
            manager.setIdleCompact(msg.on);
            break;
          case 'restart':
            manager.restart().catch(switchFailed);
            break;
        }
    };

    // a newer socket takes the window (R-M7-5): the owner is told and closed with 4001, then the newcomer attaches as on a connect
    const takeover = (ws: WebSocket, tab: string | null) => {
      const old = owner;
      if (old) {
        owner = null;
        detachers.get(old.ws)?.(); // no more frames to it, not even those between now and its close
        try {
          old.ws.send(JSON.stringify({ kind: 'taken-over' }));
        } catch { /* already dying */ }
        role.set(old.ws, 'occupied'); // a message it already had in flight is not the owner's any more
        old.ws.close(TAKEN_OVER_CODE);
      }
      attachOwner(ws, tab);
      role.set(ws, 'owner');
    };
    const role = new WeakMap<WebSocket, 'pending' | 'occupied' | 'owner'>();

    wss.on('connection', (ws, req) => {
      // this page instance's id (in memory on the page): the same tab reconnecting after a drop is not a second tab
      const params = new URL(req.url ?? '/', 'http://x').searchParams;
      const tab = params.get('tab') || null;
      // a page that is occupied or taken reconnects passive: with no owner it must not win the window by being first
      // (a restart drops both tabs); it is told `occupied` and takes over only on the user's click
      const passive = params.get('passive') === '1';
      ws.on('error', (e) => reportError(hub, 'ws', e));
      ws.on('message', guard(hub, 'ws', (data) => {
        const r = role.get(ws);
        if (r === 'pending') return; // still waiting out the grace: nothing it says counts yet
        const msg = parseClientMessage(String(data));
        if (r === 'occupied') {
          if (!('error' in msg) && msg.type === 'takeover') takeover(ws, tab);
          return; // everything else from an occupied socket is ignored
        }
        if ('error' in msg) {
          reportError(hub, 'ws', msg.error);
          return;
        }
        if (msg.type === 'takeover') return; // the owner has nothing to take
        handleOwner(ws, msg);
      }));
      if (oneTab && !passive && owner && tab !== null && owner.tab === tab) {
        // the owner's own reconnect (its old socket is a zombie the server has not noticed yet): out with the old, no grace
        const old = owner;
        owner = null;
        detachers.get(old.ws)?.();
        old.ws.terminate();
      }
      if (!oneTab || (!owner && !passive)) {
        role.set(ws, 'owner');
        attachOwner(ws, tab);
        return;
      }
      // an owner exists: a reloading tab's old socket closes within the grace, so wait before answering occupied (R-M7-6)
      role.set(ws, 'pending');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        clearTimeout(timer);
        ownerGone.off('gone', onGone);
        ws.off('close', onClose);
        if (ws.readyState !== ws.OPEN) return;
        if (!owner && !passive) {
          role.set(ws, 'owner');
          attachOwner(ws, tab);
          return;
        }
        role.set(ws, 'occupied');
        try {
          ws.send(JSON.stringify({ kind: 'occupied' }));
        } catch (e) {
          reportError(hub, 'occupied', e);
        }
        sendHello(ws);
      };
      const onGone = () => settle();
      const onClose = () => { clearTimeout(timer); ownerGone.off('gone', onGone); };
      ownerGone.on('gone', onGone);
      ws.on('close', onClose);
      timer = setTimeout(settle, graceMs);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      manager.close();
      wss.close();
      throw e; // syscall 'listen': main exits with 98, the launcher's "port taken" code
    }

    const port = (server.address() as AddressInfo).port;
    ownPort = port;
    // a supervised window keeps its registry entry's root current, so a relaunch reopens the folder it switched to
    manager.onSwitch((_id, { restart }) => {
      if (restart || !supervised()) return;
      try {
        registerWindow(port, root(), process.pid, process.ppid);
      } catch (e) {
        reportError(hub, 'windows', e);
      }
    });
    allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
    allowedOrigins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);

    let closing: Promise<void> | null = null;
    const close = () => (closing ??= new Promise<void>((resolve) => {
      hubs.delete(hub);
      if (heartbeat) clearInterval(heartbeat);
      manager.close();
      blend?.dispose();
      for (const c of wss.clients) c.terminate();
      wss.close(() => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }));
    return { url: `http://127.0.0.1:${port}`, close };
  } catch (e) {
    hubs.delete(hub);
    throw e;
  }
}
