import { createHash } from 'node:crypto';
import { cutTail, type AgentEvent } from '@nota-bene/shared';
import type { SendImage } from '../types.ts';

export const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string => typeof value === 'string' ? value : '';
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const CAP = 64 * 1024;

/** Native ids are opaque, never paths. The same transform is used for live/replay/routes. */
export function itemId(id: string): string {
  return 'codex-' + (/^[A-Za-z0-9_-]{1,110}$/.test(id) ? id : createHash('sha256').update(id).digest('hex'));
}

export function codexInput(text: string, images?: SendImage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ type: 'text', text: text || ' ', text_elements: [] }];
  for (const image of images ?? []) {
    out.push({ type: 'text', text: image.label || '[image]', text_elements: [] });
    out.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
  }
  return out;
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return cutTail(value, CAP);
  const object = record(value);
  if (Array.isArray(object.content)) return cutTail(object.content.map((part) => string(record(part).text)).filter(Boolean).join('\n'), CAP);
  return cutTail(value == null ? '' : JSON.stringify(value), CAP);
}

type Call = Extract<AgentEvent, { t: 'tool-call' }>;
function call(item: Record<string, unknown>): Omit<Call, 'id' | 't' | 'sub'> {
  const type = string(item.type);
  switch (type) {
    case 'commandExecution': return { name: 'exec_command', toolKind: 'command', input: { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}) } };
    case 'fileChange': return { name: 'apply_patch', toolKind: 'file', input: { changes: item.changes } };
    case 'mcpToolCall': return { name: `${item.server}.${item.tool}`, toolKind: 'mcp', input: record(item.arguments) };
    case 'dynamicToolCall': return { name: string(item.tool), toolKind: 'other', input: record(item.arguments) };
    case 'collabAgentToolCall': {
      const child = array(item.receiverThreadIds).find((id) => typeof id === 'string');
      return { name: string(item.tool), toolKind: child ? 'agent' : 'other', input: { ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}) }, ...(typeof child === 'string' ? { childSessionId: child } : {}) };
    }
    case 'subAgentActivity': return { name: string(item.kind) || 'subagent', toolKind: 'agent', input: { description: item.agentPath }, ...(typeof item.agentThreadId === 'string' ? { childSessionId: item.agentThreadId } : {}) };
    case 'webSearch': return { name: 'web_search', toolKind: 'search', input: { query: item.query } };
    case 'imageView': return { name: 'view_image', toolKind: 'file', input: { path: item.path } };
    case 'imageGeneration': return { name: 'image_generation', toolKind: 'other', input: { prompt: item.revisedPrompt } };
    default: return { name: string(item.tool) || type, toolKind: 'other', input: record(item.arguments) };
  }
}

/** Per conversation; turn settlement and user-send ownership live in CodexSession. */
export class CodexMapper {
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly texts = new Map<string, string>();
  private readonly output = new Map<string, string>();
  private readonly children = new Map<string, boolean>();
  private compacted = false;

  notification(method: string, params: Record<string, unknown>): AgentEvent[] {
    if (method === 'turn/started') { this.compacted = false; return []; }
    if (method === 'item/started' || method === 'item/completed') return this.item(record(params.item), method === 'item/completed');
    if (method === 'item/agentMessage/delta') {
      const id = string(params.itemId);
      if (!id || this.completed.has(id)) return [];
      const events: AgentEvent[] = [];
      if (!this.started.has(id)) { this.started.add(id); events.push({ t: 'message-start' }); }
      const delta = string(params.delta);
      this.texts.set(id, (this.texts.get(id) ?? '') + delta);
      if (delta) events.push({ t: 'message-chunk', text: delta });
      return events;
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta' || method === 'item/mcpToolCall/progress') {
      const id = string(params.itemId);
      if (!id || this.completed.has(id)) return [];
      const text = cutTail((this.output.get(id) ?? '') + string(params.delta ?? params.message), CAP);
      this.output.set(id, text);
      return [{ t: 'tool-update', id: itemId(id), text, isError: false }];
    }
    if (method === 'thread/compacted' && !this.compacted) { this.compacted = true; return [{ t: 'compacted' }]; }
    return [];
  }

  item(item: Record<string, unknown>, done: boolean): AgentEvent[] {
    const rawId = string(item.id);
    if (!rawId || this.completed.has(rawId)) return [];
    const type = string(item.type);
    if (done) this.completed.add(rawId);
    if (type === 'agentMessage' || type === 'plan') {
      if (done) {
        const text = typeof item.text === 'string' ? item.text : this.texts.get(rawId) ?? '';
        this.texts.delete(rawId);
        return text ? [{ t: 'message', id: itemId(rawId), text }] : [];
      }
      if (this.started.has(rawId)) return [];
      this.started.add(rawId);
      return [{ t: 'message-start' }];
    }
    if (type === 'contextCompaction') {
      if (done) { if (this.compacted) return []; this.compacted = true; return [{ t: 'compacted', boundaryId: itemId(rawId) }]; }
      return [{ t: 'compacting' }];
    }
    if (type === 'userMessage' || type === 'hookPrompt' || type === 'reasoning') return [];
    const events: AgentEvent[] = [];
    const info = call(item);
    const id = itemId(rawId);
    if (!this.started.has(rawId)) { this.started.add(rawId); events.push({ t: 'tool-call', id, sub: false, ...info }); }
    if (type === 'collabAgentToolCall') {
      for (const child of array(item.receiverThreadIds).filter((v): v is string => typeof v === 'string')) {
        const state = record(record(item.agentsStates)[child]);
        const status = string(state.status);
        const ended = ['completed', 'errored', 'shutdown', 'interrupted', 'notFound'].includes(status);
        const was = this.children.get(child);
        if (was === undefined || (was === false && !ended && (['pendingInit', 'running'].includes(status) || ['sendInput', 'resumeAgent', 'followupTask', 'sendMessage'].includes(string(item.tool))))) {
          this.children.set(child, true);
          events.push({ t: 'task', id: itemId(child), phase: 'started', type: 'agent', call: id, desc: string(item.prompt) || string(item.tool) });
        }
        if (ended && this.children.get(child)) {
          this.children.set(child, false);
          events.push({ t: 'task', id: itemId(child), phase: 'done', summary: string(state.message), ...(status === 'errored' || status === 'notFound' ? { status: 'failed' as const } : status === 'interrupted' || status === 'shutdown' ? { status: 'stopped' as const } : {}) });
        }
      }
    }
    if (done) {
      const text = type === 'commandExecution' ? string(item.aggregatedOutput) || this.output.get(rawId) || ''
        : type === 'mcpToolCall' ? resultText(item.error ?? item.result)
        : type === 'fileChange' ? array(item.changes).map((v) => { const change = record(v); return string(change.path) + '\n' + string(change.diff); }).join('\n')
        : type === 'imageGeneration' ? string(item.savedPath) || string(item.failure)
        : resultText(item.result ?? item.contentItems ?? item.output ?? item.agentsStates ?? '');
      events.push({ t: 'tool-update', id, ...(info.toolKind === 'agent' ? { toolKind: info.toolKind, childSessionId: info.childSessionId } : {}), text: cutTail(text, CAP), isError: ['failed', 'declined', 'errored'].includes(string(item.status)) || item.success === false || !!item.error || (typeof item.exitCode === 'number' && item.exitCode !== 0) });
      this.output.delete(rawId);
    }
    return events;
  }
}
