import type { RequestListener, ServerResponse } from 'node:http';
import { TOOL_USE_ID } from '@nota-bene/shared';
import type { AttachmentStore } from './attachments.ts';
import type { ProviderBackend as AgentBackend } from './agent/types.ts';
import { SAFE_SESSION_ID } from './comments.ts';
import { reportError } from './errors.ts';
import type { EventHub } from './hub.ts';

function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * `GET /subagent?session=<id>&tool=<toolUseId>` (protocol 7): the conversation of the subagent that the Agent call `tool`
 * started, as feed events, with `running`, `type` and `description`. Read-only. 400 for an id that is not a plain id
 * (both go into file paths downstream), 409 when `session` is not the current conversation (like /history: a page from
 * before a switch must not read another session's agents), 404 when no subagent matches.
 */
export function subagentRoutes(o: {
  backend: Pick<AgentBackend, 'subagent'>; attachments: AttachmentStore; hub: EventHub;
  current: () => string | null; root: () => string;
}): Record<string, RequestListener> {
  return {
    '/subagent': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const session = q.get('session') ?? '';
      const tool = q.get('tool') ?? '';
      if (!SAFE_SESSION_ID.test(session) || !TOOL_USE_ID.test(tool)) return text(res, 400, 'bad request');
      if (session !== o.current()) return text(res, 409, 'not the current session');
      o.backend.subagent(session, o.root(), tool, o.attachments, (e) => reportError(o.hub, 'attach', e), o.hub.callState(tool)).then(
        (view) => {
          if (!view) return text(res, 404, 'no such subagent');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(view));
        },
        (e) => {
          reportError(o.hub, 'subagent', e);
          text(res, 500, 'internal error');
        },
      );
    },
  };
}
