import fs from 'node:fs';
import path from 'node:path';
import { TOOL_USE_ID } from '@nota-bene/shared';
import { SAFE_SESSION_ID } from '../../comments.ts';

/** What Claude Code writes beside a subagent's transcript: `agent-<agentId>.meta.json`. Not an SDK API: read in one place. */
export type SubagentMeta = { agentId: string; type: string; description: string; toolUseId: string; running: boolean };

const AGENT_ID = /^[A-Za-z0-9]{1,64}$/;
const META_FILE = /^agent-([A-Za-z0-9]{1,64})\.meta\.json$/;

/**
 * The meta of the subagent that the Agent call `toolUseId` started in `sessionId`, or null (no such file, an unreadable
 * or odd one). Looks in every project under `projectsDir` (a session id is unique, and it avoids re-deriving the CLI's
 * folder naming). `running`: the CLI sets `finished` when the agent ends; a stopped one (`stoppedByUser`) never does.
 * Both ids are checked before they touch a path.
 */
export function findSubagentMeta(projectsDir: string, sessionId: string, toolUseId: string): SubagentMeta | null {
  if (!SAFE_SESSION_ID.test(sessionId) || !TOOL_USE_ID.test(toolUseId)) return null;
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
      const m = META_FILE.exec(n);
      if (!m) continue;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Record<string, unknown>;
        if (v.toolUseId !== toolUseId) continue;
        return {
          agentId: m[1]!, toolUseId,
          type: typeof v.agentType === 'string' ? v.agentType : '',
          description: typeof v.description === 'string' ? v.description : '',
          running: v.finished !== true && v.stoppedByUser !== true,
        };
      } catch {
        // a torn or foreign file: not this one
      }
    }
  }
  return null;
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
