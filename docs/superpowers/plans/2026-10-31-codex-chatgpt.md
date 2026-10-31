# Codex / ChatGPT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Run Nota Bene from Codex CLI and local Desktop using a provider-bound browser window, preserving all existing Claude behavior.

**Architecture:** Keep the existing AgentBackend/AgentSession boundary. Add a native Codex App Server adapter and provider-scoped launch/state. Claude's adapter and skill remain unchanged; ACP is a later backend behind this same boundary.

**Tech Stack:** Existing Node/TypeScript, JSONL stdio JSON-RPC, React/Redux, Vitest/Playwright. Use the installed Codex CLI; no separate model API client.

**Spec:** `docs/superpowers/specs/2026-10-31-codex-chatgpt-design.md`

## Global Constraints

- No edits to `server/src/agent/claude/**` or the existing Claude `plugin/skills/nb/**`.
- Default/legacy provider is Claude. Each browser window is fixed to its invoking provider.
- Preserve Node >=23.6 for checkout and Node >=22 for the published package.
- No provider dropdown, implicit cross-provider transcript conversion, merge, push or publication.
- Provider capabilities describe verified behavior; unknown cost/token/task facts remain unknown.
- Do not silently disable unresolved parity gates or claim full Codex parity before verifying them.
- Public tracked artifacts contain no private paths, real session identifiers or personal project data.
- Serialize suites using test ports; use temporary project/state/vault for smoke tests.

## Review Focus

- Claude and Codex launched concurrently in the same folder must never reuse one another's window, settings or transcripts.
- A completion arriving while steering/interrupt is pending must not duplicate, lose or prematurely settle a user send.
- Disconnect/switch/cancel must retire permission and question requests; late answers cannot approve the next generation.
- Existing comment anchors must identify the same text/tools after native paginated history replay and compaction.
- A Desktop launch must survive tool-shell/turn completion without orphan storms; explicit shutdown must terminate its owned child process.

---

### Task 1: Provider-scoped launcher and state

**Files:**
- Create: `server/src/agent/provider.ts`, `server/src/agent/provider.test.ts`
- Modify: `server/src/state.ts`, `server/src/main.ts`, `bin/nota-bene.mjs`
- Test: `server/src/main.test.ts`, `bin/nota-bene.test.ts`, existing state/launcher tests

**Interfaces:**
- Produces: `AgentProvider = 'claude' | 'codex'`, `parseProvider(value): AgentProvider`, `providerStateDir(base, provider): string`.
- `--agent claude|codex` defaults to Claude and survives detached launch/server supervision. Selected provider scopes state and window discovery; Claude's existing base directory remains exact.
- Native Codex executable override: `NOTA_BENE_CODEX`; otherwise resolve `codex` on PATH.

- [x] Write failing tests: invalid agent rejected; omitted agent is Claude; same-folder provider locks/lookups and last-session records are isolated; supervision preserves provider.
- [x] Run the focused provider/launcher tests and observe RED.
- [x] Implement provider selection and additive state scoping. Preserve existing launcher helpers and all Claude argument/lookup semantics.
- [x] Run focused tests and record GREEN; commit this task separately.

### Task 2: Owned Codex JSON-RPC process

**Files:**
- Create: `server/src/agent/codex/rpc.ts`, `rpc.test.ts`, `server/test/fixtures/codex-rpc.mjs`

**Interfaces:**
- Consumes: executable selection from Task 1.
- Produces: `CodexRpc` with `request(method, params?, {signal, timeoutMs}?)`, `notify(method, params?)`, notification/request subscriptions, `close()` and `closed`.
- The transport initializes once with client metadata, then sends `initialized`; server requests have a separate response path. No shell interpolation.

- [x] Write failing subprocess contract tests for chunked/coalesced JSONL, out-of-order replies, server requests, timeout/abort, malformed/oversized frames, spawn failure and child exit with pending requests.
- [x] Run `npx vitest run server/src/agent/codex/rpc.test.ts` and observe RED.
- [x] Implement bounded framing/diagnostics, owned-process shutdown and request cleanup. Use generated installed-runtime schemas as research, not unchecked copied user state.
- [x] Run transport tests and record GREEN; commit.

### Task 3: Native event/input/history normalization

**Files:**
- Create: `server/src/agent/codex/map.ts`, `map.test.ts`, `history.ts`, `history.test.ts`
- Modify: `shared/src/agent.ts`, `shared/src/tasks.ts` only for additive provider-neutral metadata/unknown facts

**Interfaces:**
- Produces: Codex item/turn mapper yielding existing AgentEvent plus optional neutral metadata; `codexInput(text, images)`; paginated history normalization into ServerEvent[].
- Message/tool ids derive from native item ids, consistently in live/replay paths. Tool categories and child/task identities are explicit, not inferred from Claude names.

- [x] Write failing fixtures for agent-message deltas/finals, command/file/MCP tools, errors, user images, child-thread links, compaction and deterministic history anchors.
- [x] Run mapper/history tests and observe RED.
- [x] Implement normalization with no fabricated timings/cost/usage, bounded output and no duplicate final text.
- [x] Verify image ordering and live/replay ids with tests; commit.

### Task 4: Codex backend lifecycle and controls

**Files:**
- Create: `server/src/agent/codex/backend.ts`, `backend.test.ts`, `session.ts`, `session.test.ts`, `controls.ts`, `controls.test.ts`
- Modify: `server/src/main.ts`, `server/src/agent/types.ts`, `server/src/sessions.ts`, `server/src/session/target.ts`, `server/src/session/identity.ts`, `server/src/session/options.ts`, `server/src/server.ts`

**Interfaces:**
- Consumes: transport and normalization; produces `codexBackend(options?): AgentBackend`.
- Preserve current `startServer({backend})` / fake backend contract. Add optional backend session-validation/discovery hooks to avoid Claude transcript fallback for Codex.
- Support native thread new/resume/fork/list/read, pagination, turn start/steer/interrupt, compact/reset, actual model/effort discovery, skills/commands, context/limit reads and targeted observable task control.
- Capture message ownership at actual acceptance. Clear starts a new native conversation without losing app comments or replay state.

- [x] Write failing lifecycle tests using the scripted transport: steering completion race, forced-send ordering, no duplicate turn end, cancelled approvals, fork source not persisted as destination, paginated history, missing login/binary, disconnect and clean close.
- [x] Run focused backend/session tests and observe RED.
- [x] Implement backend with safe provider-specific permission profiles, account status/login methods and no credential file parsing. Match installed stable/experimental API capabilities explicitly.
- [x] Exercise context/model/mode/command/task methods and actual error cases; commit with GREEN tests.

### Task 5: Provider-neutral browser controls, interactions and statistics

**Files:**
- Modify: `shared/src/protocol.ts`, `server/src/session/permissions.ts`, `server/src/session/mode.ts`, `server/src/session/model.ts`, `server/src/stats.ts`, `server/src/server.ts`
- Modify: `web/src/controls/ModePill.tsx`, `ModelPill.tsx`, `slice.ts`, `SessionPicker.tsx`, `web/src/feed/ToolLine.tsx`, `web/src/subagent/slice.ts`, relevant permission/task/stat components and `web/src/i18n/{en,ru}.ts`
- Test: existing capability/controls/permissions/feed tests plus provider-neutral regression cases

**Interfaces:**
- Add versioned optional provider identity, capability descriptors and variable-duration limit windows. Legacy clients/state use exact Claude defaults.
- Add explicit answer paths for native approval options and structured user questions; do not reduce a required answer to a fake acknowledgement.
- Server validates every operation against its fixed backend's current capabilities and generation; the browser never sends arbitrary sandbox configuration.

- [x] Write failing tests for new descriptors, unchanged legacy render/messages, task/subagent metadata, provider-specific session text, real limit durations, question answers and stale-response rejection.
- [x] Run focused shared/server/web tests and observe RED.
- [x] Implement backward-compatible controls and locale strings. Keep existing Claude control behavior; expose unavailable Codex facts with accurate explanations.
- [x] Run affected regressions and `npx tsc -b`; commit.

### Task 6: Codex nb skill, Desktop lifetime and distribution

**Files:**
- Create: `codex/skills/nb/SKILL.md`, `codex/skills/nb/open.mjs`, `scripts/codex-nb.test.ts`
- Modify: `scripts/build-package.mjs`, `bin/package.test.ts`, `README.md`, `docs/guide.md`

**Interfaces:**
- A separately installable Codex skill invokes the same provider-aware launcher with `--agent codex`.
- Support default/new/fork using the actual source thread id, never transcript mtime. Missing source id makes fork fail clearly.
- Local Desktop uses supervised detached launch and bounded authenticated readiness; CLI uses supported owned background execution. Output includes plain URL only; browser login remains in existing launcher mechanism.

- [x] Write failing launch tests for workspace with spaces, default/new/fork, absent source id, missing binary, Desktop shell/turn exit, repeated invocation and no credential output.
- [x] Run skill/package tests and observe RED.
- [x] Implement and document local installation plus CLI/Desktop invocation syntax. Package required skill/scripts without changing Claude skill files.
- [x] Run launch/package checks and verify actual Codex discovery; commit.

### Task 7: Whole-branch acceptance and parity audit

**Files:**
- Create: focused Codex scripted E2E fixtures/specs under `e2e/`
- Update: documentation with the exact verified feature matrix and runtime requirements

**Interfaces:**
- Consumes: all preceding deliverables. Produces: branch-only implementation with verified provider isolation, CLI/Desktop launch and a truthful parity report.

- [x] Run actual Codex in a disposable project with a local scripted Responses endpoint where possible, covering real wire behavior without paid model calls.
- [x] Verify ChatGPT account status/sign-in plumbing without touching the controlling thread. A real model smoke uses a fresh owned session and is identified as such.
- [x] Resolve the foreground-to-background and native prompt-suggestion gates technically. If no supported equivalent exists, report that precise workflow for a user decision; never claim complete parity or silently substitute cancellation/paid prediction.
- [x] Run `npx tsc -b`, `npm test`, `npm run build -w web`, then `npm run e2e` sequentially. Preserve exit codes and test evidence.
- [x] Get one fresh whole-branch review; fix significant findings with reproducing tests, then run affected/full regressions as justified.
- [x] Commit completed work on this branch and report tests, runtime verification and any unresolved parity gates. Do not merge or publish.

## Acceptance result

Completed on the feature branch. Independent review's six Important findings were
reproduced and fixed: pending-start cancellation, compaction/archive reconciliation,
late child metadata, process-local child liveness, sticky effort defaults and resumed
child tasks. Decline semantics and Russian labels were also corrected.

Final checks: TypeScript and web build passed; 2289 tests passed (the native contract
is opt-in and passed separately); 86 existing browser scenarios and one Codex browser
scenario passed. The native contract uses a local Responses fixture and covers a real
command plus shutdown of its running terminal, with no paid model calls.

The user accepted the documented Codex API gaps: force-background, terminal output
tail and prompt suggestions. ACP remains future work. Existing Claude adapter and
skill have no diff from the branch base. Changes remain on this branch, unmerged and
unpublished. Global skill installation is documented, not performed.
