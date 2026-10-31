import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { AgentEvent } from '@nota-bene/shared';
import { CodexRpc } from './rpc.ts';
import { CodexSession } from './session.ts';
import { loadCodexHistory } from './history.ts';
import { AttachmentStore } from '../../attachments.ts';

// Opt-in contract against the installed native CLI. A local Responses fixture makes zero paid model calls.
it.skipIf(process.env.NOTA_BENE_NATIVE_TEST !== '1')('native app-server: streams, correlates sends and replays stable history', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-native-'));
  const cwd = path.join(temp, 'project'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(cwd, '.agents/skills'), { recursive: true });
  fs.symlinkSync(path.resolve('codex/skills/nb'), path.join(cwd, '.agents/skills/nb'));
  const calls: Record<string, unknown>[] = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    const request = JSON.parse(body); calls.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `msg-${calls.length}`;
    const tools = (request.tools ?? []).flatMap((t: Record<string, unknown>) => t.type === 'namespace' ? t.tools : [t]) as Record<string, unknown>[];
    const exec = tools.find((t) => typeof t.name === 'string' && t.name.endsWith('exec_command'));
    if (calls.length === 1 && exec) {
      const quote = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
      const command = `printf '%s' \"$$\" > ${quote(path.join(cwd, 'owned.pid'))}; exec sleep 60`;
      const item = { type: 'function_call', id: 'native-tool-item', call_id: 'native-tool-call', name: exec.name, arguments: JSON.stringify({ cmd: command, yield_time_ms: 1000, max_output_tokens: 100 }) };
      const emit = (type: string, value: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response: { id: 'native-tool-response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } });
      res.end(); return;
    }
    const message = { type: 'message', id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Native fixture reply', annotations: [] }] };
    const event = (type: string, rest: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
    event('response.created', { response: { id: 'response-fixture', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event('response.output_text.delta', { item_id: id, output_index: 0, content_index: 0, delta: 'Native fixture reply' });
    event('response.output_text.done', { item_id: id, output_index: 0, content_index: 0, text: 'Native fixture reply' });
    event('response.output_item.done', { output_index: 0, item: message });
    event('response.completed', { response: { id: 'response-fixture', status: 'completed', output: [message], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.join(temp, 'codex'));
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: path.join(temp, 'codex') };
  delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  const rpcOptions = { cwd, env, args: ['app-server', '-c', 'features.unified_exec=true', '-c', 'model_provider="fixture"', '-c', 'model="fixture-model"', '-c', 'model_providers.fixture.name="Fixture"', '-c', `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`, '-c', 'model_providers.fixture.wire_api="responses"', '-c', 'model_providers.fixture.requires_openai_auth=false'], timeoutMs: 15000 };
  const rpc = new CodexRpc(rpcOptions);
  const s = new CodexSession({ cwd, permissionMode: 'codex-workspace', ask: async () => false }, rpc);
  const events: AgentEvent[] = [];
  const reading = (async () => { for await (const e of s.messages) events.push(e); })().catch((e) => { events.push({ t: 'turn-end', stop: 'failed', error: String(e), secs: 0, answers: 'none', queued: 0 }); });
  try {
    await s.ready;
    expect(await s.supportedCommands()).toContainEqual(expect.objectContaining({ name: 'nb' }));
    s.send({ uuid: 'native-send', text: 'Reply briefly', priority: 'next' });
    const end = Date.now() + 20000;
    while (!events.some((e) => e.t === 'turn-end') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(events.find((e) => e.t === 'turn-end')).toMatchObject({ stop: 'done', answers: ['native-send'] });
    const message = events.find((e) => e.t === 'message'); expect(message).toMatchObject({ text: 'Native fixture reply' });
    const id = events.find((e) => e.t === 'init'); if (id?.t !== 'init' || !id.sessionId) throw new Error('No native id');
    const history = await loadCodexHistory(rpc, id.sessionId, new AttachmentStore({ dir: path.join(temp, 'attachments') }));
    expect(history).toContainEqual(expect.objectContaining({ kind: 'user', id: 'native-send' }));
    expect(history).toContainEqual(expect.objectContaining({ kind: 'agent', e: message }));
    const reader = new CodexRpc(rpcOptions);
    try {
      await reader.request('thread/read', { threadId: id.sessionId, includeTurns: false });
      expect(await loadCodexHistory(reader, id.sessionId, new AttachmentStore({ dir: path.join(temp, 'read-attachments') }))).toContainEqual(expect.objectContaining({ kind: 'agent', e: message }));
    } finally { await reader.close(); }
    const fork = await rpc.request('thread/fork', { threadId: id.sessionId, cwd }) as { thread: { id: string } };
    expect(fork.thread.id).not.toBe(id.sessionId);
    expect(events.some((e) => e.t === 'tool-call' && e.toolKind === 'command')).toBe(true);
    const pid = Number(fs.readFileSync(path.join(cwd, 'owned.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    s.close(); await reading; await rpc.closed;
    const deadline = Date.now() + 2000;
    let alive = true;
    do { try { process.kill(pid, 0); } catch { alive = false; } if (alive) await new Promise((r) => setTimeout(r, 50)); } while (alive && Date.now() < deadline);
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    expect(alive, 'Native terminal must stop with its owning session').toBe(false);
  } finally { s.close(); await reading; await rpc.closed; await new Promise<void>((r) => server.close(() => r())); fs.rmSync(temp, { recursive: true, force: true }); }
}, 35000);
