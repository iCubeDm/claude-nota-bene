# M0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A minimal but usable Nota Bene. Chat with the real Claude Code agent in the new React UI: streaming replies, mid-turn sends, interrupt, permission cards, replay, i18n. Everything is covered by e2e tests on a fake agent.

**Architecture:** npm workspaces `shared/` (protocol types), `server/` (Node running TS natively; `AgentSession` abstraction with `SdkAgent` and `FakeAgent`; `EventHub` with replay; one WebSocket) and `web/` (Vite + React + Redux Toolkit; server events become `serverEvent` actions folded by a pure feed reducer). The server serves the built `web/dist`.

**Tech Stack:** Node 26 (type stripping), TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.310, `ws`, Vite 8, React 19, Tailwind 4, shadcn/ui, Redux Toolkit 2.13, react-redux 9.3, marked + DOMPurify + highlight.js + mermaid, Vitest 5, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-24-nota-bene-rebuild-design.md` (parity checklist section "Chat (M0)").

## Global Constraints

- Node ≥ 23.6. The server runs `.ts` directly with `node`; `tsconfig` has `erasableSyntaxOnly: true` (no enums, namespaces or parameter properties).
- The server listens on `127.0.0.1` only. The default port is 4777 (`--port`).
- No runtime state inside the repo. State goes to `~/.nota-bene/` (override `NOTA_BENE_HOME`).
- Every user-visible string goes through `t()`. Every key exists in both `ru` and `en`.
- Pin exact versions in `package.json` (`--save-exact`). The SDK is pinned at `0.3.310`.
- `prototype/` is not modified by this plan.
- Palette and chrome tokens are copied from `prototype/public/index.html` `:root` (Plannotator values). Visual parity, not a redesign.

## Commit convention

Every task is **one small, self-contained commit**. You can read the history task by task and revert any single task.

- **One task = one commit.** It contains the task's code and its tests, nothing else: no drive-by fixes, no formatting of unrelated files. A problem found in another area becomes a note for a later task, not a change here.
- **Commit only when green:** the task's tests pass and `npx tsc -b` is clean.
- **Size:** about 300 changed lines or fewer, not counting lockfiles and generated shadcn components. A task that grows past that is split before committing, and the plan is updated.
- **Message:** the subject is given in each task (`type(scope): summary`, Conventional Commits). The body has three short lines: *what* changed, *why*, *verified by* (the exact test command). The trailer is `Task: M0-NN`.
  ```
  feat(server): event hub with replay

  What: EventHub stores events and sends a replay frame to each new socket.
  Why: a reloaded page or a reconnect must see the conversation so far.
  Verified by: npx vitest run server/src/hub.test.ts (4 passed)

  Task: M0-05
  ```
- When M0 is done: the tag `m0`.

## Review Focus

1. **A malformed or unknown WebSocket message** (bad JSON, unknown `type`) → a `server-error` event to clients, and the server keeps serving. Test in M0-08.
2. **Reconnect in the middle of a streaming reply** → the replay shows the partial text once, then live deltas continue it with no duplicated block. Test in M0-13.
3. **Sending while the socket is down** → the text stays in the composer, the offline state is shown, nothing is silently dropped. Tests in M0-15 and M0-18.
4. **Interrupt while idle** (Esc or Stop with no turn running) → no error, no state change. Test in M0-04.
5. **The agent crashes mid-turn** (the SDK iterator throws) → an error item in the feed, `busy` cleared, and the next send starts a fresh agent on the same transcript. Test in M0-06.

---

## File structure

```
package.json              workspaces + root scripts
tsconfig.base.json
shared/src/protocol.ts    ClientMessage, ServerEvent, parseClientMessage
server/src/
  main.ts                 CLI: parseArgs() → startServer()
  state.ts                ~/.nota-bene paths, sessions.json
  agent/types.ts          AgentSession, AgentBackend, PermissionAsk
  agent/fake.ts           fakeBackend (scripted turns)
  agent/sdk.ts            sdkBackend (query())
  agent/transcript.ts     transcriptToEvents (resume replay)
  hub.ts                  EventHub
  errors.ts               reportError, guard()
  session.ts              SessionManager
  http.ts                 static web/dist, /info
  server.ts               startServer: http + ws wiring
  test/fixtures/*.json    fake scripts, transcript sample
web/src/
  main.tsx, App.tsx, theme.css, shell/{Header,Footer}.tsx
  i18n/{index.ts,ru.ts,en.ts}
  store/feed.ts           FeedState, reduce() (pure)
  store/store.ts          slices, makeStore, socket middleware, thunks, hooks
  net/socket.ts           connect/reconnect, send()
  feed/Markdown.tsx
  feed/{Feed,UserMessage,ToolLine,DoneLine,PermissionCard}.tsx
  composer/Composer.tsx
e2e/{playwright.config.ts,chat.spec.ts}
```

---

## Server

### M0-01: Workspace scaffold

**Files:** create `package.json` (private, `"type": "module"`, workspaces `shared`, `server`, `web`; script `test`: `vitest run`), `tsconfig.base.json` (`strict`, `module: "nodenext"`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`, `allowImportingTsExtensions`), `vitest.config.ts`; install `typescript`, `vitest` with exact versions.

- [ ] **Step 1:** Create the files; add `shared/src/smoke.test.ts` with `test('workspace runs', () => expect(1).toBe(1))`.
- [ ] **Step 2: Verify** `npm test` → 1 passed; `npx tsc -b` → clean.
- [ ] **Step 3: Commit** `chore: npm workspaces, strict TypeScript, vitest`. The smoke test is deleted in M0-02.

### M0-02: Shared protocol

**Files:** create `shared/package.json`, `shared/tsconfig.json`, `shared/src/protocol.ts`; test `shared/src/protocol.test.ts`; delete `shared/src/smoke.test.ts`.

**Interfaces — produces (`@nota-bene/shared`):**
```ts
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
export type ClientMessage =
  | { type: 'send'; id: string; text: string; force?: boolean }
  | { type: 'interrupt' }
  | { type: 'permission'; id: string; allow: boolean };
export type ServerEvent =
  | { kind: 'replay'; events: ServerEvent[] }
  | { kind: 'sdk'; m: SDKMessage; ts: number }
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; historic?: boolean }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; ts: number }
  | { kind: 'permission-done'; id: string; allow: boolean; ts: number }
  | { kind: 'session'; id: string | null; root: string }
  | { kind: 'server-error'; where: string; message: string };
export function parseClientMessage(raw: string): ClientMessage | { error: string };
```

- [ ] **Step 1: Failing tests:**
  ```ts
  test('accepts a send', () => expect(parseClientMessage('{"type":"send","id":"u1","text":"hi"}')).toEqual({ type: 'send', id: 'u1', text: 'hi' }));
  test('rejects bad json', () => expect(parseClientMessage('{nope')).toHaveProperty('error'));
  test('rejects unknown type', () => expect(parseClientMessage('{"type":"rm -rf"}')).toEqual({ error: 'unknown message type: rm -rf' }));
  test('rejects send without text', () => expect(parseClientMessage('{"type":"send","id":"u1"}')).toHaveProperty('error'));
  test('permission needs boolean allow', () => expect(parseClientMessage('{"type":"permission","id":"p","allow":"yes"}')).toHaveProperty('error'));
  ```
- [ ] **Step 2: Run** `npx vitest run shared` → FAIL (module not found).
- [ ] **Step 3: Implement** the types and a hand-written type-guard per variant (no schema library).
- [ ] **Step 4: Run** → 5 passed; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `feat(shared): client/server protocol and message validation`.

### M0-03: State directory

**Files:** create `server/package.json` (SDK `0.3.310`, `ws`), `server/tsconfig.json`, `server/src/state.ts`; test `server/src/state.test.ts`.

**Interfaces — produces:**
```ts
export function stateDir(): string;                        // NOTA_BENE_HOME ?? ~/.nota-bene, created on first call
export function lastSession(projectDir: string): string | undefined;
export function saveSession(projectDir: string, id: string | null): void;  // null deletes the entry
```

- [ ] **Step 1: Failing tests** (each with `NOTA_BENE_HOME` = a fresh `mkdtemp`):
  - save then read → `'abc'`;
  - save `null` → `undefined`;
  - a corrupt `sessions.json` (`"{"`) → `undefined`, no throw;
  - no `sessions.json.tmp*` left after a save (atomic write).
- [ ] **Step 2: Run** `npx vitest run server/src/state.test.ts` → FAIL.
- [ ] **Step 3: Implement:** write to a temp file, then `renameSync`.
- [ ] **Step 4: Run** → 4 passed.
- [ ] **Step 5: Commit** `feat(server): state directory and last-session registry`.

### M0-04: Agent interface + fake backend

**Files:** create `server/src/agent/types.ts`, `server/src/agent/fake.ts`; test `server/src/agent/fake.test.ts`.

**Interfaces — produces:**
```ts
export type PermissionAsk = (toolName: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
export interface AgentSession {
  readonly messages: AsyncIterable<SDKMessage>;             // ends after close()
  send(m: { uuid: string; text: string; priority: 'next' | 'now' }): void;
  interrupt(): Promise<void>;                                // no-op when idle
  close(): void;
}
export interface AgentBackend {
  start(o: { cwd: string; resume?: string; ask: PermissionAsk }): AgentSession;
  history(sessionId: string, cwd: string): Promise<ServerEvent[]>;
}
export type FakeTurn = { text: string; chunk?: number; delayMs?: number;
  tools?: { name: string; input: Record<string, unknown> }[];
  ask?: { toolName: string; input: Record<string, unknown> }; crash?: boolean };
export function fakeBackend(turns: FakeTurn[]): AgentBackend;
```
The fake emits SDK-shaped messages:
- on start: `system/init` with `session_id: 'fake-session'`;
- per send:
  1. `stream_event`: a `content_block_start`, then `content_block_delta` chunks of `chunk` chars (default 8), `delayMs` apart (default 0);
  2. `assistant` with `uuid` `fake-a-<n>`: the full text plus the tool_use blocks;
  3. the `ask` → `ask()`, waiting for the answer;
  4. `result` with `duration_ms`.
- `crash` → the iterator throws after the first delta.
- Turns are used in order; the last one repeats. `history()` returns `[]`.

- [ ] **Step 1: Failing tests:**
  - `streams deltas then assistant then result`: `{text:'hello world', chunk:5}` → types `['system', 'stream_event' ×4, 'assistant', 'result']`;
  - `assistant text equals concatenated deltas`;
  - `ask waits for permission`: `ask` resolving `false` after 50ms → `result` ≥ 50ms after `assistant`;
  - `interrupt mid-turn ends with result subtype error_during_execution`;
  - `interrupt while idle resolves and emits nothing` (Review Focus 4);
  - `crash makes the iterator throw`.
- [ ] **Step 2: Run** `npx vitest run server/src/agent` → FAIL.
- [ ] **Step 3: Implement** with an internal queue and an async generator.
- [ ] **Step 4: Run** → 6 passed.
- [ ] **Step 5: Commit** `feat(server): AgentSession interface and scripted fake backend`.

### M0-05: Event hub + error reporting

**Files:** create `server/src/hub.ts`, `server/src/errors.ts`; test `server/src/hub.test.ts`.

**Interfaces — produces:**
```ts
export class EventHub {
  emit(ev: ServerEvent, o?: { store?: boolean }): void;   // store defaults to true; stamps ts when absent
  attach(sock: { send(data: string): void }): () => void;  // sends {kind:'replay', events} first; returns detach
  reset(events?: ServerEvent[]): void;
}
export function reportError(hub: EventHub, where: string, e: unknown): void;   // console.error + server-error (store: false)
export function guard<A extends unknown[]>(hub: EventHub, where: string, fn: (...a: A) => void): (...a: A) => void;  // sync throw → reportError
```

- [ ] **Step 1: Failing tests:**
  - `late subscriber gets a replay of stored events`;
  - `store:false events reach live sockets but not the replay`;
  - `reset replaces history`;
  - `guard reports instead of throwing` → a `server-error` reaches the socket.
- [ ] **Step 2: Run** `npx vitest run server/src/hub.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 4 passed.
- [ ] **Step 5: Commit** `feat(server): event hub with replay and error reporting`.

### M0-06: Session manager

**Files:** create `server/src/session.ts`; test `server/src/session.test.ts`.

**Interfaces — consumes:** `EventHub`, `reportError`, `AgentBackend`, `saveSession`. **Produces:**
```ts
export type SessionManager = {
  send(m: { id: string; text: string; force?: boolean }): void;
  interrupt(): void;
  answer(permissionId: string, allow: boolean): void;
  info(): { id: string | null; root: string };
};
export function createSessionManager(o: { hub: EventHub; backend: AgentBackend; cwd: string; resume?: string }): Promise<SessionManager>;
```
Behaviour:
- `send` emits `user` and then calls `agent.send` with `priority: force ? 'now' : 'next'`; `force` interrupts first.
- `system/init` → `saveSession(cwd, id)` + a `session` event.
- With `resume`: `hub.reset(await backend.history(resume, cwd))` before starting.
- A permission ask → a `permission` event, resolved by `answer()` → `permission-done`.
- When the iterator throws: `reportError`, then a stored `sdk` result `{type:'result', subtype:'error_during_execution', is_error:true, result: message}`. The next `send` starts a new agent with `resume` = the last session id.

- [ ] **Step 1: Failing tests** (fake backend, temp `NOTA_BENE_HOME`):
  - `send emits user then the agent reply`;
  - `force send interrupts and uses priority now`;
  - `permission round-trip` → `permission`, `answer(id, true)` → `permission-done {allow:true}` → `result`;
  - `saves the session id on init` → `lastSession(cwd) === 'fake-session'`;
  - `crash surfaces an error and recovers` (Review Focus 5) → `server-error` + an error result; the next send produces a normal reply.
- [ ] **Step 2: Run** `npx vitest run server/src/session.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 5 passed.
- [ ] **Step 5: Commit** `feat(server): session manager over AgentSession`.

### M0-07: HTTP routes

**Files:** create `server/src/http.ts`; test `server/src/http.test.ts`.

**Interfaces — produces:**
```ts
export function httpHandler(o: { hub: EventHub; webDist: string; info: () => object; extra?: Record<string, RequestListener> }): RequestListener;
```
Routes: `GET /info` → JSON from `info()`; static files from `webDist` with an `index.html` fallback for unknown paths; `..` in a path → 403. Every route goes through one try/catch: a throw → 500 with the message plus `reportError`. `extra` exists for tests.

- [ ] **Step 1: Failing tests** (plain `http.createServer` on port 0, a temp `webDist` with `index.html` and `a.js`):
  - `/info returns json`;
  - `serves a static file with its content type`;
  - `unknown path falls back to index.html`;
  - `path traversal is 403`;
  - `a throwing route becomes 500 with its message`.
- [ ] **Step 2: Run** `npx vitest run server/src/http.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 5 passed.
- [ ] **Step 5: Commit** `feat(server): http routes with static web and error guard`.

### M0-08: Server assembly (HTTP + WebSocket)

**Files:** create `server/src/server.ts`; test `server/src/server.test.ts`.

**Interfaces — consumes:** `httpHandler`, `EventHub`, `createSessionManager`, `parseClientMessage`. **Produces:**
```ts
export function startServer(o: { cwd: string; port: number; backend: AgentBackend; resume?: string; webDist: string }):
  Promise<{ url: string; close(): Promise<void> }>;
```
Listens on `127.0.0.1`. Each socket is `hub.attach`ed. Inbound frames go through `parseClientMessage` and are dispatched to the session manager; an `{error}` → `reportError(hub, 'ws', …)`. Also registers `process.on('uncaughtException' | 'unhandledRejection')` → `reportError`.

- [ ] **Step 1: Failing tests** (fake backend, port 0, a `ws` client):
  - `chat round-trip over ws` → `user` (id `u1`) … `sdk/result`;
  - `malformed message does not kill the server` (Review Focus 1): `'{nope'` and `'{"type":"x"}'` → two `server-error`s; `/info` still 200;
  - `a second client gets the replay`.
- [ ] **Step 2: Run** `npx vitest run server/src/server.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 3 passed.
- [ ] **Step 5: Commit** `feat(server): assemble http and websocket server`.

### M0-09: SDK backend + transcript replay

**Files:** create `server/src/agent/sdk.ts`, `server/src/agent/transcript.ts`, `server/test/fixtures/transcript.json` (a sample `getSessionMessages` result: user text, assistant with a tool_use, user tool_result, assistant text); test `server/src/agent/transcript.test.ts`.

**Interfaces — produces:**
```ts
export function transcriptToEvents(msgs: SessionMessage[]): ServerEvent[];   // pure
export function sdkBackend(): AgentBackend;
```
- `sdkBackend().start()`: `query()` with streaming input; `includePartialMessages: true`; `permissionMode: 'auto'`; `systemPrompt: {type:'preset', preset:'claude_code', append}`, where `append` is the prototype's `APPEND` text verbatim (`prototype/server.mjs`); `extraArgs: { chrome: null }`; `canUseTool` → `ask`. `send` pushes `SDKUserMessage` with `uuid` and `priority`.
- `history()` = `transcriptToEvents(await getSessionMessages(id, {dir: cwd}))`. The `session` event after init comes from the session manager (M0-06), and the reducer shows it as the «resumed» notice when the feed already has history.
- The mapping ports the prototype's "rebuild the feed from the transcript" block: tool_result-only user turns skipped; `historic: true`. Images come in M2.

- [ ] **Step 1: Failing tests** on the fixture:
  - `maps assistant messages to sdk events`;
  - `skips tool_result-only user turns`;
  - `user text becomes historic user events in order`.
- [ ] **Step 2: Run** `npx vitest run server/src/agent/transcript.test.ts` → FAIL.
- [ ] **Step 3: Implement** both files. `sdk.ts` has no unit test: it is a thin adapter, covered by the M0-20 smoke test.
- [ ] **Step 4: Run** → 3 passed; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `feat(server): Agent SDK backend and transcript replay`.

### M0-10: CLI

**Files:** create `server/src/main.ts`; test `server/src/main.test.ts`.

**Interfaces — produces:**
```ts
export function parseArgs(argv: string[], cwd: string): { dir: string; port: number; resume?: string; continue: boolean; fake?: string };
```
Usage: `node server/src/main.ts [dir] [--port N] [--resume ID] [--continue] [--fake script.json]`.
- `dir` is resolved and realpath'd; the port defaults to 4777.
- `--continue` → `resume = lastSession(dir)`.
- `--fake` → `fakeBackend(JSON.parse(file))`, otherwise `sdkBackend()`.
- Runs `startServer` and prints the URL.

- [ ] **Step 1: Failing tests:**
  - `defaults: cwd and 4777`;
  - `parses --port --resume --fake`;
  - `rejects a non-numeric port` with a thrown usage message.
- [ ] **Step 2: Run** `npx vitest run server/src/main.test.ts` → FAIL.
- [ ] **Step 3: Implement**; the module runs `main()` only when it is the entry point.
- [ ] **Step 4: Run** → 3 passed.
- [ ] **Step 5: Commit** `feat(server): command line entry point`.

## Web

### M0-11: Web scaffold, theme, shell

**Files:** create `web/package.json`, `web/vite.config.ts` (dev proxy for `/info` and the WebSocket → `127.0.0.1:4777`), `web/index.html`, `web/src/{main.tsx,App.tsx,theme.css}`, `web/src/shell/{Header,Footer}.tsx`; shadcn/ui init with `button` and `tooltip`; copy `prototype/public/{icon.svg,favicon.svg,icon-180.png,icon-512.png}` → `web/public/`.

`theme.css` holds the prototype's `:root` tokens as CSS variables, mapped into Tailwind 4 `@theme`. The shell matches the prototype: header 48px (logo, project, path, connection, session), footer slot, paper card over the 24px grid. Strings are temporarily hard-coded English; M0-12 replaces them.

- [ ] **Step 1:** Create the files.
- [ ] **Step 2: Verify** `npm run build -w web` succeeds; `npx tsc -b` clean.
- [ ] **Step 3: Commit** `feat(web): vite/react scaffold, theme tokens and app shell`. The commit body notes that shadcn's generated files are excluded from the size budget.

### M0-12: i18n

**Files:** create `web/src/i18n/{index.ts,ru.ts,en.ts}`; modify `web/src/shell/{Header,Footer}.tsx` (strings through `t()`, RU/EN toggle in the header); test `web/src/i18n/i18n.test.ts`.

**Interfaces — produces:**
```ts
export type Lang = 'ru' | 'en';
export function t(key: keyof typeof ru, ...args: unknown[]): string;
export function useT(): typeof t;                 // re-renders on language change
export function setLang(l: Lang): void;           // localStorage 'lang'
export function initialLang(navLang: string, stored: string | null): Lang;
```
The dictionaries hold only M0 keys (header, composer, feed lines, permission card, errors), with values copied from the prototype's `STR`.

- [ ] **Step 1: Failing tests:**
  - `ru and en have the same keys`;
  - `t('sendN', 3) === 'Отправить (3)'` in ru;
  - `initialLang('ru-RU', null) === 'ru'`, `initialLang('en-US', null) === 'en'`, `initialLang('ru-RU', 'en') === 'en'`.
- [ ] **Step 2: Run** `npx vitest run web/src/i18n` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 3 passed.
- [ ] **Step 5: Commit** `feat(web): ru/en i18n with browser default and toggle`.

### M0-13: Feed model (pure reducer)

**Files:** create `web/src/store/feed.ts`; test `web/src/store/feed.test.ts`.

**Interfaces — consumes:** `ServerEvent`. **Produces:**
```ts
export type FeedItem =
  | { kind: 'user'; id: string; text: string; ts: number; force?: boolean; duringWork?: boolean }
  | { kind: 'assistant'; id: string; text: string; final: boolean }      // `${uuid}:${blockIndex}`; while streaming `stream:${n}`
  | { kind: 'tool'; id: string; name: string; arg: string; sub: boolean; error?: boolean }
  | { kind: 'done'; secs: number; ts: number; interrupted: boolean; error?: string }
  | { kind: 'permission'; id: string; toolName: string; input: Record<string, unknown>; answer?: boolean }
  | { kind: 'notice'; text: string };
export type FeedState = { items: FeedItem[]; busy: boolean; session: { id: string | null; root: string } | null; forcePending: boolean };
export const emptyFeed: FeedState;
export function reduce(s: FeedState, ev: ServerEvent): FeedState;   // pure; 'replay' folds from emptyFeed with busy false
```
The tool `arg` follows the prototype's `toolSummary`: the first of `command`, `file_path`, `pattern`, `description`, `url`, `query`, `skill`, `prompt`; first line only; 160 chars.

- [ ] **Step 1: Failing tests:**
  - `deltas build one streaming item, assistant finalises it in place` → one item `{id:'a1:0', text:'hello world', final:true}`;
  - `replay mid-stream then live deltas continue the same item` (Review Focus 2) → one item with the full text;
  - `user while busy is marked duringWork`;
  - `force keeps busy across the interrupted result`; the next result clears it;
  - `tool_result is_error marks the tool red`;
  - `permission-done records the answer`;
  - `subagent tool lines are sub; subagent text is not added`.
- [ ] **Step 2: Run** `npx vitest run web/src/store/feed.test.ts` → FAIL.
- [ ] **Step 3: Implement** with exhaustive switches (`never` checks).
- [ ] **Step 4: Run** → 7 passed.
- [ ] **Step 5: Commit** `feat(web): pure feed reducer over server events`.

### M0-14: Socket client

**Files:** create `web/src/net/socket.ts`; test `web/src/net/socket.test.ts`.

**Interfaces — produces:**
```ts
export function connect(url: string, onEvent: (ev: ServerEvent) => void, onState: (s: 'open' | 'closed') => void,
  WS?: typeof WebSocket): { send(m: ClientMessage): boolean; close(): void };   // reconnects every 1000ms; send false when not open
```

- [ ] **Step 1: Failing tests** with an injected fake `WebSocket` class:
  - `send returns false while closed and true after open`;
  - `reconnects after close within 1.1s`;
  - `close() stops reconnecting`.
- [ ] **Step 2: Run** `npx vitest run web/src/net` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 3 passed.
- [ ] **Step 5: Commit** `feat(web): websocket client with reconnect`.

### M0-15: Redux store

**Files:** create `web/src/store/store.ts`; modify `web/src/main.tsx` (`<Provider>`); test `web/src/store/store.test.ts`.

**Interfaces — consumes:** `reduce`, `emptyFeed`, `connect`. **Produces:**
```ts
export const serverEvent: ActionCreatorWithPayload<ServerEvent>;   // the only way server data enters the store
export const feedSlice: Slice<FeedState>;                           // extraReducers: serverEvent → reduce(state, ev)
export const connSlice: Slice<{ state: 'open' | 'closed' }>;
export function makeStore(o: { url: string; connect?: typeof connect }): EnhancedStore;   // socket middleware
export const sendMessage: (text: string, force: boolean) => AppThunk<boolean>;           // false while closed
export const interrupt: () => AppThunk<void>;                                             // no-op when idle
export const answerPermission: (id: string, allow: boolean) => AppThunk<void>;
export const useAppSelector: TypedUseSelectorHook<RootState>;
export const useAppDispatch: () => AppDispatch;
export const selectBusy: (s: RootState) => boolean;
```
`sendMessage` generates the message id with `crypto.randomUUID()`. DevTools are on only when `import.meta.env.DEV`.

- [ ] **Step 1: Failing tests** with a fake `connect`:
  - `inbound frames reach the feed`: `user` + `sdk/result` → `selectBusy` false and two items;
  - `sendMessage returns false while closed` (Review Focus 3);
  - `interrupt while idle sends nothing`;
  - `devtools only in dev`.
- [ ] **Step 2: Run** `npx vitest run web/src/store/store.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 4 passed.
- [ ] **Step 5: Commit** `feat(web): redux store with socket middleware`.

### M0-16: Markdown renderer

**Files:** create `web/src/feed/Markdown.tsx`; test `web/src/feed/Markdown.test.tsx`.

**Interfaces — produces:** `export const Markdown: React.MemoExoticComponent<(p: { text: string; final: boolean }) => JSX.Element>`.

marked + DOMPurify (allow `video`, `audio`, `controls`, `preload`) + highlight.js. When `final`: ```` ```mermaid ```` renders through mermaid (dark theme, as in the prototype); ```` ```svg ```` renders as sanitised SVG. Images point to `/file?path=` (the route arrives in M2).

- [ ] **Step 1: Failing tests** (jsdom + testing-library):
  - `renders code with hljs classes`;
  - `final mermaid block becomes .mermaid-out`;
  - `non-final mermaid stays a code block`;
  - `sanitises <script>`.
- [ ] **Step 2: Run** `npx vitest run web/src/feed/Markdown.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 4 passed.
- [ ] **Step 5: Commit** `feat(web): markdown renderer with code, mermaid and svg`.

### M0-17: Feed components

**Files:** create `web/src/feed/{Feed,UserMessage,ToolLine,DoneLine,PermissionCard}.tsx`; modify `web/src/App.tsx`; test `web/src/feed/Feed.test.tsx`.

**Interfaces — consumes:** `FeedItem`, `Markdown`, `useAppSelector`, `answerPermission`, `t`.

The visuals match the prototype:
- the user bubble with the meta line (`t('you')` · time · `t('youBusy')` / `t('youForced')`);
- `▸ Tool · arg` (sub lines indented, errors red);
- the done line (`t('done')` / `t('interrupted')` · secs · time);
- the permission card (allow/deny → the resolved state);
- auto-scroll only when already at the bottom.

- [ ] **Step 1: Failing tests** (a store preloaded through `serverEvent`):
  - `renders one element per feed item in order`;
  - `user meta shows "while working"`;
  - `permission buttons dispatch answerPermission and the card shows the answer`.
- [ ] **Step 2: Run** `npx vitest run web/src/feed/Feed.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 3 passed.
- [ ] **Step 5: Commit** `feat(web): chat feed components`.

### M0-18: Composer

**Files:** create `web/src/composer/Composer.tsx`; modify `web/src/shell/Footer.tsx`; test `web/src/composer/Composer.test.tsx`.

**Interfaces — consumes:** `sendMessage`, `interrupt`, `selectBusy`, the conn state, `t`.

Keys:
- Enter → send;
- Shift+Enter → new line;
- ⌘/Ctrl+Enter → force when busy (a plain send when idle);
- Esc → interrupt when busy.

The field grows to 40vh. Stop is enabled only while busy. The ? tip shows `t('keysTip')`.

- [ ] **Step 1: Failing tests:**
  - `Enter sends and clears`;
  - `Shift+Enter adds a newline`;
  - `keeps text when send fails` (Review Focus 3): with the socket closed, the text stays and `t('offline')` is visible.
- [ ] **Step 2: Run** `npx vitest run web/src/composer` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → 3 passed.
- [ ] **Step 5: Commit** `feat(web): composer with send, force and stop`.

## End to end

### M0-19: e2e on the fake agent

**Files:** create `e2e/playwright.config.ts`, `e2e/chat.spec.ts`, `server/test/fixtures/{chat.json,slow.json,ask.json}`; root script `e2e`: `playwright test`.

The Playwright `webServer` runs `npm run build -w web && node server/src/main.ts <tmpdir> --port 4791 --fake server/test/fixtures/<script>.json` with `NOTA_BENE_HOME` set to a temp dir; one project per fixture.

- [ ] **Step 1: Write the specs:**
  - `streams a markdown reply and shows the done line` (chat.json: a heading, code and a mermaid block) → `.mermaid-out svg` is visible; the done line matches `/готово|done/`;
  - `mid-turn send is marked while working` (slow.json, `delayMs: 200`);
  - `force send interrupts` → the first done line says interrupted;
  - `Esc and Stop interrupt`;
  - `permission allow` (ask.json) → the card shows allowed; the turn completes;
  - `reload replays the conversation`;
  - `language toggle switches the placeholder`.
- [ ] **Step 2: Run** `npm run e2e` → 7 passed.
- [ ] **Step 3: Commit** `test(e2e): chat flows on the fake agent`.

### M0-20: Dev/start scripts, docs, real-agent smoke

**Files:** modify the root `package.json` scripts:
- `dev`: `concurrently "node --watch server/src/main.ts --port 4777" "vite --config web/vite.config.ts"`;
- `start`: `npm run build -w web && node server/src/main.ts`.

Also modify the root `CLAUDE.md` (how to run `dev` / `test` / `e2e`; ports: 4777 real use, 4790 smoke, 4791 e2e).

- [ ] **Step 1:** Add the scripts and docs.
- [ ] **Step 2: Real-agent smoke (manual).**
  1. `mkdir -p /tmp/nb-m0 && NOTA_BENE_HOME=/tmp/nb-m0-home npm start -- /tmp/nb-m0 --port 4790`.
  2. Ask "create hello.txt with hi"; answer the permission card if one appears; send a message mid-turn; interrupt a long answer; restart with `--continue`.
  3. Expected: the reply streams; `hello.txt` exists; the header shows the session id; the conversation is replayed after the restart.
  4. Remove the temp dirs and the test session afterwards.
- [ ] **Step 3: Commit** `chore: dev/start scripts and run docs`. Then `git tag m0`.
