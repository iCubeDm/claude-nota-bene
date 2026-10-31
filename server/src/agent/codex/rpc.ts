import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type RpcRequest = { id: string | number; method: string; params: Record<string, unknown> };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; dispose(): void };
type RpcOptions = { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxFrameBytes?: number };

/** An owned app-server process. No model calls, auth-file reads or shell commands here. */
export class CodexRpc {
  readonly ready: Promise<unknown>;
  readonly closed: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly asks = new Map<string | number, AbortController>();
  private readonly notifications = new Set<(method: string, params: Record<string, unknown>) => void>();
  private handler: ((request: RpcRequest, signal: AbortSignal) => Promise<unknown>) | undefined;
  private ended: Error | undefined;
  private nextId = 0;
  private text = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly options: RpcOptions;
  private closeResolve!: () => void;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(options: RpcOptions = {}) {
    this.options = options;
    this.closed = new Promise((resolve) => { this.closeResolve = resolve; });
    this.child = spawn(options.command ?? process.env.NOTA_BENE_CODEX ?? process.env.CODEX_CLI_PATH ?? 'codex', options.args ?? ['app-server'], {
      cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.child.stdout.on('data', (data: Buffer) => this.receive(data));
    // Consume diagnostics without forwarding opaque data (which can include config secrets) to the UI.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error('Codex input stream closed')));
    this.child.on('error', (e: NodeJS.ErrnoException) => this.fail(new Error(`Cannot start Codex (${e.code ?? 'spawn error'}). Install Codex or set NOTA_BENE_CODEX.`)));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex exited (${signal ?? code ?? 'unknown'})`)));
    this.child.on('close', () => {
      // The leader may exit while a tool descendant ignores TERM. Retire the owned group before resolving close.
      if (process.platform !== 'win32' && this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* group already gone */ } }
      clearTimeout(this.killTimer); this.closeResolve();
    });
    this.ready = this.call('initialize', {
      clientInfo: { name: 'nota-bene', title: 'Nota Bene', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }).then((info) => { this.notify('initialized'); return info; });
    void this.ready.catch(() => {}); // ready may reject before the first caller subscribes
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notifications.add(handler);
    return () => { this.notifications.delete(handler); };
  }

  onRequest(handler: (request: RpcRequest, signal: AbortSignal) => Promise<unknown>): void {
    this.handler = handler;
  }

  async request<T = unknown>(method: string, params: unknown = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (options.signal) {
      const signal = options.signal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Codex request aborted')); };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        this.ready.then(() => { signal.removeEventListener('abort', abort); resolve(); }, (e) => { signal.removeEventListener('abort', abort); reject(e); });
      });
    } else await this.ready;
    return await this.call(method, params, options) as T;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private call(method: string, params: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.ended) return Promise.reject(this.ended);
    if (options.signal?.aborted) return Promise.reject(new Error('Codex request aborted'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const remove = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => { remove(); reject(new Error('Codex request aborted')); };
      const timer = setTimeout(() => { remove(); reject(new Error(`Codex ${method} timed out`)); }, options.timeoutMs ?? this.options.timeoutMs ?? 30_000);
      timer.unref();
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, dispose: remove });
      try { this.write({ id, method, params }); } catch (error) { remove(); reject(error); }
    });
  }

  private write(frame: unknown): void {
    if (this.ended) throw this.ended;
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  private receive(data: Buffer): void {
    if (this.ended) return;
    this.text += this.decoder.write(data);
    const max = this.options.maxFrameBytes ?? 32 * 1024 * 1024;
    for (;;) {
      const newline = this.text.indexOf('\n');
      if (newline < 0) break;
      const line = this.text.slice(0, newline);
      this.text = this.text.slice(newline + 1);
      if (Buffer.byteLength(line) > max) return this.fail(new Error('Codex frame exceeds size limit'));
      if (!line.trim()) continue;
      try { this.frame(JSON.parse(line)); } catch { return this.fail(new Error('Invalid Codex JSON frame')); }
    }
    if (Buffer.byteLength(this.text) > max) this.fail(new Error('Codex frame exceeds size limit'));
  }

  private frame(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid frame');
    const frame = value as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
    if (typeof frame.method === 'string') {
      const params = frame.params && typeof frame.params === 'object' ? frame.params as Record<string, unknown> : {};
      if (typeof frame.id === 'number' || typeof frame.id === 'string') {
        void this.answer({ id: frame.id, method: frame.method, params });
      } else {
        if (frame.method === 'serverRequest/resolved') {
          const id = params.requestId;
          if (typeof id === 'string' || typeof id === 'number') { this.asks.get(id)?.abort(); this.asks.delete(id); }
        }
        for (const handler of this.notifications) handler(frame.method, params);
      }
      return;
    }
    if (typeof frame.id !== 'number') throw new Error('invalid response id');
    const waiting = this.pending.get(frame.id);
    if (!waiting) return; // late response after timeout/abort
    waiting.dispose();
    if (frame.error) waiting.reject(new Error(typeof frame.error.message === 'string' ? frame.error.message : 'Codex request failed'));
    else if ('result' in frame) waiting.resolve(frame.result);
    else waiting.reject(new Error('Invalid Codex JSON response'));
  }

  private async answer(request: RpcRequest): Promise<void> {
    const controller = new AbortController();
    this.asks.set(request.id, controller);
    let response: unknown;
    try {
      if (!this.handler) throw new Error(`Unsupported Codex request: ${request.method}`);
      response = { id: request.id, result: await this.handler(request, controller.signal) };
    } catch (error) {
      response = { id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : 'Request failed' } };
    }
    if (!controller.signal.aborted && !this.ended) this.write(response);
    this.asks.delete(request.id);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = error;
    for (const waiting of [...this.pending.values()]) { waiting.dispose(); waiting.reject(error); }
    for (const controller of this.asks.values()) controller.abort();
    this.asks.clear();
    this.stop();
  }

  private stop(): void {
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, name);
        else this.child.kill(name);
      } catch { /* already exited */ }
    };
    signal('SIGTERM');
    if (!this.killTimer) { this.killTimer = setTimeout(() => signal('SIGKILL'), 1000); this.killTimer.unref(); }
  }

  async close(): Promise<void> {
    this.fail(new Error('Codex connection closed'));
    await this.closed;
  }
}
