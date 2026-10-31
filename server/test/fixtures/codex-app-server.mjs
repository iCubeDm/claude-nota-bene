#!/usr/bin/env node
// Scripted native JSON-RPC peer for browser acceptance tests; no model API or account files.
import readline from 'node:readline';
import fs from 'node:fs';
const tid = '11111111-0000-4000-8000-000000000001';
const cwd = process.env.NB_CODEX_FIXTURE_CWD ?? process.cwd();
const store = process.env.NB_CODEX_FIXTURE_STATE;
let turns = []; try { turns = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {}
const emit = (method, params) => process.stdout.write(JSON.stringify({ method, params: { threadId: tid, ...params } }) + '\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
const asks = new Map(); let n = 0;
const thread = () => ({ id: tid, cwd, name: 'Codex fixture', preview: 'Browser acceptance', updatedAt: 1, status: { type: 'idle' } });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const r = JSON.parse(line); const p = r.params ?? {};
  if (!r.method) { asks.get(r.id)?.(r.result); asks.delete(r.id); continue; }
  if (r.id === undefined) continue;
  if (r.method === 'initialize') reply(r.id, { userAgent: 'fixture' });
  else if (r.method === 'account/read') reply(r.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  else if (r.method === 'model/list') reply(r.id, { data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'GPT fixture', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] });
  else if (r.method === 'skills/list') reply(r.id, { data: [] });
  else if (r.method === 'account/rateLimits/read') reply(r.id, { rateLimits: { primary: { usedPercent: 23, windowDurationMins: 120, resetsAt: null } } });
  else if (r.method === 'thread/start' || r.method === 'thread/resume' || r.method === 'thread/fork') reply(r.id, { thread: thread(), model: 'gpt-fixture' });
  else if (r.method === 'thread/read') reply(r.id, { thread: thread() });
  else if (r.method === 'thread/list') reply(r.id, { data: [thread()] });
  else if (r.method === 'thread/turns/list') { try { turns = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {} reply(r.id, { data: turns }); }
  else if (r.method === 'thread/backgroundTerminals/list') reply(r.id, { data: [] });
  else if (r.method === 'turn/start') {
    const turnId = `turn-${++n}`; const input = p.input ?? [];
    const text = input.filter((i) => i.type === 'text').map((i) => i.text).join('\n');
    reply(r.id, { turn: { id: turnId } }); emit('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    const finish = (value) => {
      const message = { type: 'agentMessage', id: `answer-${n}`, text: value, phase: 'final_answer' };
      emit('item/completed', { turnId, item: message });
      const turn = { id: turnId, status: 'completed', items: [{ type: 'userMessage', id: `user-${n}`, clientId: p.clientUserMessageId, content: input }, message] };
      turns.push(turn); if (store) fs.writeFileSync(store, JSON.stringify(turns));
      emit('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 200 }, modelContextWindow: 1000 } });
      emit('turn/completed', { turn });
    };
    if (text.includes('question')) {
      const id = `question-${n}`; asks.set(id, (a) => finish('Answer: ' + (a?.answers?.colour?.answers ?? []).join(', ')));
      process.stdout.write(JSON.stringify({ id, method: 'item/tool/requestUserInput', params: { threadId: tid, turnId, itemId: id, isBlocking: true, questions: [{ id: 'colour', header: 'Colour', question: 'Which colour?', options: [{ label: 'Blue', description: 'A cool colour' }], isOther: true }] } }) + '\n');
    } else finish('Codex: ' + text);
  } else reply(r.id, {});
}
