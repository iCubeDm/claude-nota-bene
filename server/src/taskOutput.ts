import type { RequestListener, ServerResponse } from 'node:http';
import { TASK_ID, type TaskOutputView } from '@nota-bene/shared';
import { SAFE_SESSION_ID } from './comments.ts';
import type { EventHub } from './hub.ts';

function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/**
 * `GET /task-output?session=<id>&task=<taskId>` (protocol 8): the end of a background shell / Monitor task's output
 * (at most 8 KiB, escape sequences left in) and whether the task still runs. Same rules as `/subagent`: 400 for ids that
 * are not plain ids, 409 when `session` is not the current conversation, 404 when the server does not know the task (or
 * it is not a shell task: only those have an output). `running` is read BEFORE the output, so `running: false` means the
 * output was read after the task ended (a client that sees it has the final tail). 502 when the agent will not answer.
 */
export function taskOutputRoutes(o: {
  hub: EventHub; current: () => string | null;
  taskOutput: (taskId: string) => Promise<{ output: string; totalBytes: number; truncated: boolean }>;
}): Record<string, RequestListener> {
  return {
    '/task-output': (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed', { allow: 'GET, HEAD' });
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const session = q.get('session') ?? '';
      const task = q.get('task') ?? '';
      if (!SAFE_SESSION_ID.test(session) || !TASK_ID.test(task)) return text(res, 400, 'bad request');
      if (session !== o.current()) return text(res, 409, 'not the current session');
      const known = o.hub.task(task);
      if (!known || known.kind !== 'shell') return text(res, 404, 'no such task');
      const running = known.status === 'running';
      o.taskOutput(task).then(
        (r) => {
          const view: TaskOutputView = { output: r.output, totalBytes: r.totalBytes, truncated: r.truncated, running };
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(view));
        },
        // not a server fault worth a toast per poll: the tab keeps its last output and shows the note
        (e) => text(res, 502, e instanceof Error ? e.message : 'the agent did not answer'),
      );
    },
  };
}
