import { CODEX_MODES, EFFORT_LEVELS, type Capabilities, type AgentEffort as EffortLevel, type Interaction, type InteractionAnswer, type AgentMode as Mode, type ModelOption, type Stats } from '@nota-bene/shared';
import type { RpcRequest } from './rpc.ts';
import type { ProviderStartOptions as StartOptions } from '../types.ts';
import { array, record, string } from './map.ts';

export interface CodexConnection {
  request(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void;
  onRequest(handler: (request: RpcRequest, signal: AbortSignal) => Promise<unknown>): void;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}
export const CODEX_CAPABILITIES: Capabilities = {
  provider: 'codex', compact: true, clear: true, fork: true, usage: true, fileSuggestions: true, idleCompact: true, models: true,
  modes: [...CODEX_MODES], taskBackground: false, taskOutput: false, suggestions: false,
  modeDescriptors: [
    { id: 'codex-configured', name: 'Codex config', description: 'Inherit Codex approval and sandbox settings. Changes apply to the next turn.' },
    { id: 'codex-read-only', name: 'Read only', description: 'Read-only sandbox; request approval when necessary. Applies to the next turn.' },
    { id: 'codex-workspace', name: 'Workspace', description: 'Write inside the workspace; request approval for additional access. Applies to the next turn.' },
    { id: 'codex-full-access', name: 'Full access', description: 'Disable the sandbox and approval prompts. Applies to the next turn.' },
  ],
};
export function policy(mode: Mode, cwd: string, turn = false): Record<string, unknown> {
  if (mode === 'codex-configured') return {};
  if (!CODEX_MODES.includes(mode as typeof CODEX_MODES[number])) throw new Error('Unsupported Codex permission profile');
  const sandbox = mode === 'codex-read-only' ? 'read-only' : mode === 'codex-workspace' ? 'workspace-write' : 'danger-full-access';
  return { approvalPolicy: mode === 'codex-full-access' ? 'never' : 'on-request', ...(turn
    ? { sandboxPolicy: sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } : { type: sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess' } }
    : { sandbox }) };
}
export function models(value: unknown): ModelOption[] {
  return array(record(value).data).map(record).filter((m) => !m.hidden).map((m) => ({ value: string(m.model) || string(m.id), name: string(m.displayName) || string(m.id), description: string(m.description), ...(EFFORT_LEVELS.includes(m.defaultReasoningEffort as EffortLevel) ? { defaultEffort: m.defaultReasoningEffort as EffortLevel } : {}), efforts: array(m.supportedReasoningEfforts).map((v) => record(v).reasoningEffort).filter((e): e is EffortLevel => EFFORT_LEVELS.includes(e as EffortLevel)) }));
}
export function limits(value: unknown): NonNullable<Stats['windows']> {
  const r = record(record(value).rateLimits ?? value);
  return ['primary', 'secondary'].flatMap((key) => {
    const w = record(r[key]); if (typeof w.usedPercent !== 'number') return [];
    return [{ label: string(r.limitName) || key, minutes: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null, utilization: w.usedPercent, resets_at: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null }];
  });
}

export async function answerNative(request: RpcRequest, signal: AbortSignal, o: StartOptions): Promise<unknown> {
  const p = request.params;
  const interact = async (prompt: Interaction): Promise<InteractionAnswer | null> => o.interact ? o.interact(prompt, p, signal) : null;
  if (/item\/(commandExecution|fileChange)\/requestApproval$/.test(request.method)) {
    const decisions = array(p.availableDecisions).length ? array(p.availableDecisions) : ['accept', 'decline'];
    // Exact advertised decisions, including scoped amendments, stay on the server.
    const choices = decisions.map((d, i) => ({ id: String(i), label: typeof d === 'string' ? d : JSON.stringify(d), allow: d !== 'decline' && d !== 'cancel' }));
    if (o.interact) {
      const a = await interact({ title: string(p.reason) || string(p.command) || 'Codex approval', choices });
      const index = a && choices.findIndex((c) => c.id === a.choice);
      return { decision: typeof index === 'number' && index >= 0 ? decisions[index] : 'decline' };
    }
    const allow = await o.ask(request.method, p, signal);
    return { decision: allow && decisions.includes('accept') ? 'accept' : 'decline' };
  }
  if (request.method === 'item/permissions/requestApproval') {
    const a = await interact({ title: string(p.reason) || 'Additional Codex permissions', choices: [{ id: 'turn', label: 'Allow for this turn' }, { id: 'session', label: 'Allow for this session' }, { id: 'deny', label: 'Deny' }] });
    return { permissions: a && ['turn', 'session'].includes(a.choice) ? p.permissions : {}, scope: a?.choice === 'session' ? 'session' : 'turn' };
  }
  if (request.method === 'item/tool/requestUserInput') {
    const qs = array(p.questions).map(record);
    const a = await interact({ title: 'Codex', choices: [{ id: 'submit', label: 'Send answers' }, { id: 'cancel', label: 'Cancel' }], fields: qs.map((q) => ({ id: string(q.id), label: string(q.question), secret: q.isSecret === true, options: array(q.options).map((v) => string(record(v).label)), required: true })) });
    if (a?.choice !== 'submit') return { answers: {} };
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of qs) { const id = string(q.id), value = a.values?.[id]; if (!value) throw new Error('Missing question answer'); answers[id] = { answers: [value] }; }
    return { answers };
  }
  if (request.method === 'mcpServer/elicitation/request') {
    if (p.mode === 'openai/userVerification') throw new Error('MCP device verification requires a native host authenticator; this browser cannot verify it.');
    // Native MCP forms are flat primitive schemas. JSON preserves numbers, arrays and booleans without coercion.
    const schema = record(p.requestedSchema);
    const a = await interact({ title: string(p.message) || 'MCP request', ...(typeof p.url === 'string' && /^https?:\/\//.test(p.url) ? { url: p.url } : {}), choices: [{ id: 'accept', label: 'Accept' }, { id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Cancel' }], ...(p.requestedSchema ? { fields: [{ id: 'json', label: JSON.stringify(schema, null, 2), required: true }] } : {}) });
    if (a?.choice !== 'accept') return { action: a?.choice === 'decline' ? 'decline' : 'cancel' };
    if (!p.requestedSchema) return { action: 'accept' };
    const content: unknown = JSON.parse(a.values?.json ?? ''); validateForm(content, schema);
    return { action: 'accept', content };
  }
  throw new Error(`Unsupported Codex request: ${request.method}`);
}
function validateForm(content: unknown, schema: Record<string, unknown>): void {
  const c = record(content), props = record(schema.properties);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Expected a JSON object');
  for (const id of array(schema.required)) if (typeof id === 'string' && !(id in c)) throw new Error(`Missing field: ${id}`);
  for (const [id, v] of Object.entries(c)) {
    const s = record(props[id]);
    const type = s.type;
    if (!Object.hasOwn(props, id) || (type === 'array' ? !Array.isArray(v) : type === 'integer' ? !Number.isInteger(v) : typeof v !== type)) throw new Error(`Invalid field: ${id}`);
    const enumValues = array(s.enum).length ? array(s.enum) : array(s.oneOf).map((x) => record(x).const);
    if (enumValues.length && !enumValues.includes(v)) throw new Error(`Invalid option: ${id}`);
    if (typeof v === 'number' && ((typeof s.minimum === 'number' && v < s.minimum) || (typeof s.maximum === 'number' && v > s.maximum))) throw new Error(`Out of range: ${id}`);
    if (typeof v === 'string' && ((typeof s.minLength === 'number' && v.length < s.minLength) || (typeof s.maxLength === 'number' && v.length > s.maxLength))) throw new Error(`Invalid length: ${id}`);
    if (Array.isArray(v)) {
      const items = record(s.items), opts = array(items.enum).length ? array(items.enum) : array(items.anyOf).map((x) => record(x).const);
      if (v.some((x) => typeof x !== 'string' || (opts.length && !opts.includes(x))) || (typeof s.minItems === 'number' && v.length < s.minItems) || (typeof s.maxItems === 'number' && v.length > s.maxItems)) throw new Error(`Invalid selection: ${id}`);
    }
  }
}
