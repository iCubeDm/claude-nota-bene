import fs from 'node:fs';
import path from 'node:path';
import { TOOL_USE_ID } from '@nota-bene/shared';
import { SAFE_SESSION_ID } from '../../comments.ts';

/** What Claude Code writes beside a subagent's transcript: `agent-<agentId>.meta.json`. Not an SDK API: read in one place. */
export type SubagentMeta = {
  agentId: string; type: string; description: string; toolUseId: string;
  /** the CLI's own word: not ended (`finished` absent) and not stopped. Not proof of life: see `isRunning` */
  unfinished: boolean;
  /** when the subagent's transcript was last written (ms); 0 when it has none */
  modified: number;
};

const AGENT_ID = /^[A-Za-z0-9]{1,64}$/;
const META_FILE = /^agent-([A-Za-z0-9]{1,64})\.meta\.json$/;

/** How long a transcript that nobody confirms as live still counts as running (a CLI that does not write `finished`). */
export const RECENT_MS = 10 * 60_000;

/**
 * Whether the subagent is running. `finished` is a newer CLI field and an agent killed mid-run never gets it, so a missing
 * flag proves nothing: it runs only if this process has a live task for its call, or its transcript was written a moment ago.
 */
export const isRunning = (m: Pick<SubagentMeta, 'unfinished' | 'modified'>, live: boolean, now = Date.now()): boolean =>
  m.unfinished && (live || now - m.modified < RECENT_MS);

// toolUseId -> where its meta lives: that mapping never changes, so a poll reads one file, not every meta of every project.
// A miss is remembered for MISS_TTL_MS (the poll interval), so a poll that finds nothing does not rescan on every request.
const MISS_TTL_MS = 1500;
const where = new Map<string, { dir: string; agentId: string }>();
const missed = new Map<string, number>();

function readMeta(dir: string, agentId: string, toolUseId: string): SubagentMeta | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')) as Record<string, unknown>;
    if (v.toolUseId !== toolUseId) return null;
    let modified = 0;
    try { modified = fs.statSync(path.join(dir, `agent-${agentId}.jsonl`)).mtimeMs; } catch { /* no transcript yet */ }
    return {
      agentId, toolUseId, modified,
      type: typeof v.agentType === 'string' ? v.agentType : '',
      description: typeof v.description === 'string' ? v.description : '',
      unfinished: v.finished !== true && v.stoppedByUser !== true,
    };
  } catch {
    return null; // a torn or foreign file: not this one
  }
}

/**
 * The meta of the subagent that the Agent call `toolUseId` started in `sessionId`, or null (no such file, an unreadable
 * or odd one). Looks in every project under `projectsDir` (a session id is unique, and it avoids re-deriving the CLI's
 * folder naming), once; later calls read only the matching meta. Both ids are checked before they touch a path.
 */
export function findSubagentMeta(projectsDir: string, sessionId: string, toolUseId: string, now = Date.now()): SubagentMeta | null {
  if (!SAFE_SESSION_ID.test(sessionId) || !TOOL_USE_ID.test(toolUseId)) return null;
  const key = `${projectsDir}\0${sessionId}\0${toolUseId}`;
  const hit = where.get(key);
  if (hit) {
    const m = readMeta(hit.dir, hit.agentId, toolUseId);
    if (m) return m;
    where.delete(key); // moved or deleted: look again
  }
  const miss = missed.get(key);
  if (miss !== undefined && now - miss < MISS_TTL_MS) return null;
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const p of projects) {
    const dir = path.join(projectsDir, p, sessionId, 'subagents');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const id = META_FILE.exec(n)?.[1];
      if (!id) continue;
      const m = readMeta(dir, id, toolUseId);
      if (m) {
        where.set(key, { dir, agentId: id });
        missed.delete(key);
        return m;
      }
    }
  }
  missed.set(key, now);
  return null;
}

/** Forgets what was found and what was missed (tests). */
export function resetSubagentCache(): void {
  where.clear();
  missed.clear();
}

/** The fallback: the Agent tool's result text names the agent (`agentId: a1b2…`). */
export function agentIdFromResult(text: string): string | null {
  const m = /\bagentId:\s*([A-Za-z0-9]+)/.exec(text);
  return m && AGENT_ID.test(m[1]!) ? m[1]! : null;
}

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown };

/** A tool call of the main transcript: its input, and its result text when it has one (images and other blocks left out). */
export function toolCallIn(msgs: { type: string; message: unknown }[], toolUseId: string): { input: Record<string, unknown>; result?: string } | null {
  let call: { input: Record<string, unknown>; result?: string } | null = null;
  for (const m of msgs) {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (m.type === 'assistant' && b.type === 'tool_use' && b.id === toolUseId) call = { input: b.input ?? {} };
      else if (m.type === 'user' && b.type === 'tool_result' && b.tool_use_id === toolUseId && call) {
        call.result = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? (b.content as Block[]).map((x) => (x as { text?: string }).text ?? '').join('\n') : '';
      }
    }
  }
  return call;
}
