import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { parseClientMessage } from '@nota-bene/shared';
import type { Comment } from '@nota-bene/shared';
import type { AgentBackend } from './agent/types.ts';
import { guard, reportError } from './errors.ts';
import { AttachmentStore, attachmentRoutes } from './attachments.ts';
import { CommentStore } from './comments.ts';
import { EventHub } from './hub.ts';
import { complete, fileRoutes } from './fileRoutes.ts';
import { httpHandler, isAllowedHost } from './http.ts';
import { SwitchError, createSessionManager } from './session.ts';
import { listSessionsView } from './sessions.ts';
import { stateDir } from './state.ts';

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
  webDist: string;
  allowedOrigins?: string[];
}): Promise<{ url: string; close(): Promise<void> }> {
  const hub = new EventHub();
  installProcessHandlers();
  hubs.add(hub);
  try {
    const attachments = new AttachmentStore({ dir: path.join(stateDir(), 'attachments') });
    const manager = await createSessionManager({
      hub,
      attachments,
      backend: o.backend,
      cwd: o.cwd,
      ...(o.resume ? { resume: o.resume } : {}),
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
    const allowedHosts: string[] = []; // filled after listen, once the port is known
    const allowedOrigins: string[] = [...(o.allowedOrigins ?? [])];
    // the one source of the project root: a switch changes it, so every route reads it per request
    const root = () => manager.info().root;
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
    const server = http.createServer(httpHandler({
      hub,
      allowedHosts,
      allowedOrigins,
      extra: {
        ...fileRoutes({ root, hub, complete: (q) => complete({ session: manager, root: root() }, q) }),
        ...attachmentRoutes(attachments, hub),
        '/sessions': sessionsRoute,
      },
      webDist: o.webDist,
      info: () => {
        const { id, root, title, model } = manager.info();
        return { root, session: id, title, model };
      },
    }));
    const switchFailed = (e: unknown) => reportError(hub, e instanceof SwitchError ? e.where : 'switch', e);
    const wss = new WebSocketServer({
      server,
      verifyClient: ({ req }, done) => {
        const origin = req.headers.origin;
        const ok = isAllowedHost(req.headers.host, allowedHosts)
          && (origin === undefined || allowedOrigins.includes(origin));
        if (ok) done(true);
        else done(false, 403, 'forbidden');
      },
    });

    wss.on('connection', (ws) => {
      const detach = hub.attach({ send: (d) => ws.send(d) });
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
      try {
        ws.send(JSON.stringify({ kind: 'stats', stats: manager.stats() }));
      } catch (e) {
        reportError(hub, 'stats', e);
      }
      ws.on('close', detach);
      ws.on('error', (e) => reportError(hub, 'ws', e));
      ws.on('message', guard(hub, 'ws', (data) => {
        const msg = parseClientMessage(String(data));
        if ('error' in msg) {
          reportError(hub, 'ws', msg.error);
          return;
        }
        switch (msg.type) {
          case 'send':
            if (manager.switching()) {
              // before markSent: a refused send must not flip its comments to sent
              reportError(hub, 'busy', new Error('the session is switching; the message was not sent'));
              break;
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
            try {
              broadcastComments(store.merge(manager.info().id, msg.items));
            } catch (e) {
              reportError(hub, 'comments', e); // nothing stored, nothing broadcast; the socket stays up
            }
            break;
          case 'mode':
            void manager.setMode(msg.mode);
            break;
          case 'interrupt':
            manager.interrupt();
            break;
          case 'permission':
            manager.answer(msg.id, msg.allow);
            break;
          case 'command':
            manager.command(msg.name);
            break;
          case 'switch':
            manager.switch({ id: msg.id, dir: msg.dir }).catch(switchFailed);
            break;
          case 'restart':
            manager.restart().catch(switchFailed);
            break;
        }
      }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const port = (server.address() as AddressInfo).port;
    allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
    allowedOrigins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);

    let closing: Promise<void> | null = null;
    const close = () => (closing ??= new Promise<void>((resolve) => {
      hubs.delete(hub);
      manager.close();
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
