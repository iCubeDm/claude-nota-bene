import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { parseClientMessage } from '@nota-bene/shared';
import type { AgentBackend } from './agent/types.ts';
import { guard, reportError } from './errors.ts';
import { EventHub } from './hub.ts';
import { httpHandler } from './http.ts';
import { createSessionManager } from './session.ts';

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
    const server = http.createServer(httpHandler({
      hub,
      webDist: o.webDist,
      info: () => {
        const { id, root } = manager.info();
        return { root, session: id };
      },
    }));
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      const detach = hub.attach({ send: (d) => ws.send(d) });
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
            manager.send({ id: msg.id, text: msg.text, ...(msg.force ? { force: true } : {}) });
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

    let closing: Promise<void> | null = null;
    const close = () => (closing ??= new Promise<void>((resolve) => {
      hubs.delete(hub);
      for (const c of wss.clients) c.terminate();
      wss.close(() => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close };
  } catch (e) {
    hubs.delete(hub);
    throw e;
  }
}
