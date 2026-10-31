import fs from 'node:fs';
import path from 'node:path';
import type { ProviderBackend as AgentBackend, SessionListEntry } from '../types.ts';
import { CODEX_CAPABILITIES, type CodexConnection } from './controls.ts';
import { CodexRpc } from './rpc.ts';
import { CodexSession } from './session.ts';
import { loadCodexHistory } from './history.ts';
import { array, itemId, record, string } from './map.ts';
const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
export function codexBackend(options: { connect?: (cwd?: string) => CodexConnection } = {}): AgentBackend {
  const connect = options.connect ?? ((cwd?: string) => new CodexRpc({ cwd }));
  let metadata: CodexConnection | undefined;
  const sessions = new Set<CodexSession>();
  const links = new Map<string, Map<string, string>>();
  const remember = (root: string, events: Awaited<ReturnType<typeof loadCodexHistory>>) => {
    let map = links.get(root); if (!map) links.set(root, map = new Map());
    for (const e of events) if (e.kind === 'agent' && e.e.t === 'tool-call' && e.e.childSessionId) map.set(e.e.id, e.e.childSessionId);
    return events;
  };
  const rpc = () => {
    if (!metadata) { const connection = connect(); metadata = connection; void connection.closed.then(() => { if (metadata === connection) metadata = undefined; }); }
    return metadata;
  };
  const read = async (id: string) => record(record(await rpc().request('thread/read', { threadId: id, includeTurns: false })).thread);
  return {
    capabilities: CODEX_CAPABILITIES, nativeSessions: true,
    start(o) { const s = new CodexSession(o, connect(o.cwd)); sessions.add(s); void s.rpc.closed.then(() => sessions.delete(s)); return s; },
    async close() { for (const s of sessions) s.close(); await Promise.all([...sessions].map((s) => s.rpc.closed)); await metadata?.close(); },
    async account() { const r = record(await rpc().request('account/read', {})); return { signedIn: !!r.account || r.requiresOpenaiAuth === false, required: r.requiresOpenaiAuth === true }; },
    async login() { const r = record(await rpc().request('account/login/start', { type: 'chatgpt' })); const url = string(r.authUrl); if (!/^https:\/\//.test(url)) throw new Error('Codex did not return a sign-in URL'); return { url }; },
    async listSessions() {
      const out: SessionListEntry[] = []; let cursor: string | undefined; const seen = new Set<string>();
      do {
        const p = record(await rpc().request('thread/list', { limit: 100, sortKey: 'updated_at', ...(cursor ? { cursor } : {}) }));
        for (const t of array(p.data).map(record)) if (t.id && t.cwd) out.push({ sessionId: string(t.id), cwd: string(t.cwd), customTitle: string(t.name) || undefined, firstPrompt: string(t.preview) || undefined, lastModified: typeof t.updatedAt === 'number' ? t.updatedAt * 1000 : 0 });
        cursor = string(p.nextCursor); if (cursor && seen.has(cursor)) throw new Error('Invalid Codex session cursor'); seen.add(cursor);
      } while (cursor && out.length < 1000);
      return out;
    },
    async sessionInfo(id, dir) { const t = await read(id); if (!t.cwd || real(string(t.cwd)) !== real(dir)) return null; return { cwd: string(t.cwd), customTitle: string(t.name) || undefined, firstPrompt: string(t.preview) || undefined }; },
    async history(id, cwd, attachments, onError) {
      const t = await read(id); if (!t.cwd || real(string(t.cwd)) !== real(cwd)) throw new Error('Codex conversation belongs to another folder');
      return remember(id, await loadCodexHistory(rpc(), id, attachments, onError));
    },
    async subagent(sessionId, cwd, call, attachments, onError) {
      const parent = await read(sessionId); if (!parent.cwd || real(string(parent.cwd)) !== real(cwd)) return null;
      let child = links.get(sessionId)?.get(call) ?? [...sessions].map((s) => s.childFor(call)).find(Boolean);
      if (!child) {
        const queue = [sessionId], seen = new Set<string>();
        while (queue.length && seen.size < 100 && !child) {
          const id = queue.shift()!; if (seen.has(id)) continue; seen.add(id);
          const events = remember(sessionId, await loadCodexHistory(rpc(), id, attachments, onError));
          for (const e of events) if (e.kind === 'agent' && e.e.t === 'tool-call' && e.e.childSessionId) {
            if (e.e.id === call) child = e.e.childSessionId;
            else queue.push(e.e.childSessionId);
          }
        }
      }
      if (!child) return null;
      const thread = await read(child);
      return { events: remember(sessionId, await loadCodexHistory(rpc(), child, attachments, onError)), running: record(thread.status).type === 'active', type: 'Codex', description: string(thread.name) || string(thread.preview) || itemId(child) };
    },
  };
}
