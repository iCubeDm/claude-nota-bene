import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRpc } from './rpc.ts';

const fixture = fileURLToPath(new URL('../../../test/fixtures/codex-rpc.mjs', import.meta.url));
const clients: CodexRpc[] = [];
const rpc = (extra: Record<string, unknown> = {}) => {
  const client = new CodexRpc({ command: process.execPath, args: [fixture], ...extra });
  clients.push(client);
  return client;
};
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });

describe('Codex JSON-RPC transport', () => {
  it('initializes and matches out-of-order request responses', async () => {
    const client = rpc();
    expect(await client.request('echo', { value: 1 })).toEqual({ value: 1, initialized: true });
    const a = client.request('delayed', { ms: 20, value: 'first' });
    const b = client.request('delayed', { ms: 0, value: 'second' });
    expect(await b).toBe('second');
    expect(await a).toBe('first');
  });

  it('decodes UTF-8 split inside characters and handles server requests', async () => {
    const client = rpc();
    client.onRequest(async (request) => ({ decision: request.method.includes('Approval') ? 'accept' : 'decline' }));
    const approved = new Promise<unknown>((resolve) => client.onNotification((method, params) => { if (method === 'approved') resolve(params); }));
    expect(await client.request('fragment')).toBe('Привет');
    await client.request('serverAsk');
    expect(await approved).toEqual({ decision: 'accept' });
  });

  it('times out and aborts independently without corrupting later requests', async () => {
    const client = rpc();
    await expect(client.request('hang', {}, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    const controller = new AbortController();
    const pending = client.request('hang', {}, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(await client.request('echo')).toEqual({ initialized: true });
  });

  it.each(['malformed', 'oversized', 'exit'])('rejects every pending request when the process %s', async (method) => {
    const client = rpc({ maxFrameBytes: 1024 });
    await client.ready;
    const pending = client.request('hang');
    const failed = client.request(method);
    await expect(failed).rejects.toThrow(/JSON|frame|exited/i);
    await expect(pending).rejects.toThrow(/JSON|frame|exited/i);
  });

  it('fails clearly for a missing executable and never hangs close', async () => {
    const client = rpc({ command: '/does-not-exist/codex' });
    await expect(client.request('echo')).rejects.toThrow(/start Codex/i);
    await client.close();
  });
});
