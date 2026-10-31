#!/usr/bin/env node
// A scripted `codex app-server` for the README screenshot: no model, no account. One turn, which stops on a command approval.
import readline from 'node:readline';

const tid = '11111111-0000-4000-8000-000000000001';
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const emit = (method, params) => process.stdout.write(JSON.stringify({ method, params: { threadId: tid, ...params } }) + '\n');
const thread = { id: tid, cwd: process.cwd(), name: 'Retry limit', preview: 'Cap the retries', updatedAt: 1, status: { type: 'idle' } };
const MODEL = { id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5-Codex', description: 'Optimized for coding', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high' };
const READ = 'I read `src/store.ts`. `generateCode` retries in a loop with no upper bound, so a full code space would spin forever.\n\n```mermaid\nflowchart LR\n  A[Generate code] --> B{Taken?}\n  B -- no --> C[Store link]\n  B -- yes --> D{Tries left?}\n  D -- yes --> A\n  D -- no --> E[Throw an error]\n```\n\nI capped it at five tries and it now throws an error after that.';

for await (const line of readline.createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  if (r.id === undefined || !r.method) continue;
  if (r.method === 'initialize') reply(r.id, { userAgent: 'nota-bene/0.166.0' });
  else if (r.method === 'account/read') reply(r.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  else if (r.method === 'model/list') reply(r.id, { data: [MODEL] });
  else if (r.method === 'skills/list') reply(r.id, { data: [] });
  else if (r.method === 'account/rateLimits/read') reply(r.id, { rateLimits: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: null } } });
  else if (/^thread\/(start|resume|fork)$/.test(r.method)) reply(r.id, { thread, model: MODEL.model, reasoningEffort: 'high' });
  else if (r.method === 'thread/read') reply(r.id, { thread });
  else if (r.method === 'thread/list') reply(r.id, { data: [thread] });
  else if (r.method === 'thread/turns/list' || r.method === 'thread/backgroundTerminals/list') reply(r.id, { data: [] });
  else if (r.method === 'turn/start') {
    const turnId = 'turn-1';
    reply(r.id, { turn: { id: turnId } });
    emit('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    emit('item/completed', { turnId, item: { type: 'commandExecution', id: 'read-1', command: 'sed -n 1,40p src/store.ts', cwd: process.cwd(), status: 'completed', exitCode: 0, aggregatedOutput: '' } });
    emit('item/completed', { turnId, item: { type: 'agentMessage', id: 'answer-1', text: READ, phase: 'commentary' } });
    emit('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 48200 }, modelContextWindow: 272000 } });
    // a moment later, as a real turn would: an approval is emitted at once, the items above go through the session's queue
    setTimeout(() => process.stdout.write(JSON.stringify({ id: 'approve-1', method: 'item/commandExecution/requestApproval', params: { threadId: tid, turnId, itemId: 'test-1', command: 'npm test', reason: 'Run the test suite', availableDecisions: ['accept', 'decline'] } }) + '\n'), 300);
  } else reply(r.id, {});
}
