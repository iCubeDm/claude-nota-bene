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

function readMeta(dir: string, agentId: string, toolUseId?: string): SubagentMeta | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8')) as Record<string, unknown>;
    if (toolUseId !== undefined && v.toolUseId !== toolUseId) return null;
    let modified = 0;
    try { modified = fs.statSync(path.join(dir, `agent-${agentId}.jsonl`)).mtimeMs; } catch { /* no transcript yet */ }
    return {
      agentId, toolUseId: typeof v.toolUseId === 'string' ? v.toolUseId : '', modified,
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

/** The meta of a subagent by its own id (any call), looked up in every project like findSubagentMeta; null when absent. */
export function findSubagentMetaByAgent(projectsDir: string, sessionId: string, agentId: string): SubagentMeta | null {
  if (!SAFE_SESSION_ID.test(sessionId) || !AGENT_ID.test(agentId)) return null;
  let projects: string[];
  try { projects = fs.readdirSync(projectsDir); } catch { return null; }
  for (const p of projects) {
    const m = readMeta(path.join(projectsDir, p, sessionId, 'subagents'), agentId);
    if (m) return m;
  }
  return null;
}

export type AgentHit = { agentId: string; type: string; description: string; running: boolean; /** found through a SendMessage's `to` */ viaSend: boolean };

// A hit does not change (a call names one agent for good), so it is kept per (session, call): a running agent's tab polls
// every 1.5 s and must not parse the whole main transcript each time. Only `running` is read afresh (a file stat).
const HIT_CAP = 200;
const hits = new Map<string, AgentHit>();
/** The cached hit, only while the agent is still listed (its files may be gone: then it is a miss again, not an empty 200). */
export const hitGet = (key: string, ids: string[]): AgentHit | undefined => {
  const h = hits.get(key);
  return h && ids.includes(h.agentId) ? h : undefined;
};
export function hitSet(key: string, h: AgentHit): void {
  if (hits.size >= HIT_CAP) hits.delete(hits.keys().next().value!);
  hits.set(key, h);
}
/** The cached hit with `running` read again from the agent's meta (a resumed agent's run state moves). */
export function hitFresh(h: AgentHit, projectsDir: string, sessionId: string, live: boolean, now = Date.now()): AgentHit {
  if (!h.viaSend) return h;
  const meta = findSubagentMetaByAgent(projectsDir, sessionId, h.agentId);
  // type and description too: a hit made before the meta was written would otherwise keep '' for good
  return { ...h, type: meta?.type || h.type, description: meta?.description || h.description, running: meta ? isRunning(meta, live, now) : false };
}

/**
 * No meta names the call. The main transcript may still say which subagent it is: an Agent call by `agentId:` in its result
 * (an older CLI), a SendMessage call (a resume: the SDK's second task_started carries that call's id, and a tab saved with
 * it must still open) by `input.to`, which counts only when it is a plain id that `ids` lists (`to` may be a name: a miss).
 */
export function agentOfCall(
  msgs: { type: string; message: unknown }[], toolUseId: string, ids: string[], projectsDir: string, sessionId: string, live: boolean, now = Date.now(),
): AgentHit | null {
  const found = toolCallIn(msgs, toolUseId);
  if (!found) return null;
  if (found.name === 'SendMessage') {
    const to = found.input.to;
    if (typeof to !== 'string' || !AGENT_ID.test(to) || !ids.includes(to)) return null;
    const meta = findSubagentMetaByAgent(projectsDir, sessionId, to);
    return { agentId: to, type: meta?.type ?? '', description: meta?.description ?? '', running: meta ? isRunning(meta, live, now) : false, viaSend: true };
  }
  const id = found.result ? agentIdFromResult(found.result) : null;
  if (!id || !ids.includes(id)) return null;
  return { agentId: id, type: String(found.input.subagent_type ?? ''), description: String(found.input.description ?? ''), running: false, viaSend: false };
}

/**
 * A miss of the main-transcript fallback (no meta, and the Agent call does not name an agent we can list): remembered for
 * NO_META_TTL_MS so a poll does not parse the whole main transcript on every request, then tried again. It must expire: the
 * agent's files can appear after the first miss (listed late, meta written late), and a miss that stood until the call's
 * result arrived left a running subagent's tab saying "not in the current session".
 */
export const NO_META_TTL_MS = 4000;
const noMeta = new Map<string, number>();
export const noMetaHas = (key: string, now = Date.now()): boolean => {
  const at = noMeta.get(key);
  if (at === undefined) return false;
  if (now - at < NO_META_TTL_MS) return true;
  noMeta.delete(key);
  return false;
};
export function noMetaAdd(key: string, now = Date.now()): void {
  for (const [k, at] of noMeta) if (now - at >= NO_META_TTL_MS) noMeta.delete(k); // the map stays small
  noMeta.set(key, now);
}

/** Forgets what was found and what was missed (tests). */
export function resetSubagentCache(): void {
  where.clear();
  missed.clear();
  noMeta.clear();
  hits.clear();
}

/** The fallback: the Agent tool's result text names the agent (`agentId: a1b2…`). */
export function agentIdFromResult(text: string): string | null {
  const m = /\bagentId:\s*([A-Za-z0-9]+)/.exec(text);
  return m && AGENT_ID.test(m[1]!) ? m[1]! : null;
}

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown };

/** A tool call of the main transcript: its input, and its result text when it has one (images and other blocks left out). */
export function toolCallIn(msgs: { type: string; message: unknown }[], toolUseId: string): { name?: string; input: Record<string, unknown>; result?: string } | null {
  let call: { name?: string; input: Record<string, unknown>; result?: string } | null = null;
  for (const m of msgs) {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (m.type === 'assistant' && b.type === 'tool_use' && b.id === toolUseId) call = { ...(b.name ? { name: b.name } : {}), input: b.input ?? {} };
      else if (m.type === 'user' && b.type === 'tool_result' && b.tool_use_id === toolUseId && call) {
        call.result = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? (b.content as Block[]).map((x) => (x as { text?: string }).text ?? '').join('\n') : '';
      }
    }
  }
  return call;
}
