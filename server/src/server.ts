import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { parseClientMessage } from '@nota-bene/shared';
import type { Comment } from '@nota-bene/shared';
import type { AgentBackend } from './agent/types.ts';
import { guard, reportError } from './errors.ts';
import { CommentStore } from './comments.ts';
import { EventHub } from './hub.ts';
import { httpHandler, isAllowedHost } from './http.ts';
import { createSessionManager } from './session.ts';
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
    const manager = await createSessionManager({
      hub,
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
    const allowedHosts: string[] = []; // filled after listen, once the port is known
    const server = http.createServer(httpHandler({
      hub,
      allowedHosts,
      webDist: o.webDist,
      info: () => {
        const { id, root } = manager.info();
        return { root, session: id };
      },
    }));
    const allowedOrigins: string[] = [...(o.allowedOrigins ?? [])];
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
            if (msg.commentIds?.length) {
              // before the agent call: the UI flips to sent even if the agent later fails
              try {
                broadcastComments(store.markSent(manager.info().id, msg.commentIds, msg.id));
              } catch (e) {
                reportError(hub, 'comments', e); // the message itself must still go out
              }
            }
            manager.send({ id: msg.id, text: msg.text, ...(msg.force ? { force: true } : {}) });
            break;
          case 'comments':
            try {
              broadcastComments(store.merge(manager.info().id, msg.items));
            } catch (e) {
              reportError(hub, 'comments', e); // nothing stored, nothing broadcast; the socket stays up
            }
            break;
          case 'interrupt':
            manager.interrupt();
            break;
          case 'permission':
            manager.answer(msg.id, msg.allow);
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
