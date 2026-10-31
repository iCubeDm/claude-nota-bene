# Codex / ChatGPT support alongside Claude

Status: proposed design for review. Branch: `feat/codex-chatgpt`.

## Intent

Use Codex with a ChatGPT account in Nota Bene's existing review workflow: chat,
inline comment batches, files, media, sessions, agent controls and work inspection.
Keep the current Claude implementation and every existing Claude feature working.
The user prefers a common interface, potentially ACP, without reducing functionality.

This document describes the outcome and architecture to review before product code.
The transport recommendation is an engineering proposal. Launch ownership and the
provider-bound browser behavior below were clarified by the user during review.

## Recommended architecture

Keep `AgentBackend` / `AgentSession` and normalized `AgentEvent` as the common
application interface. Add a Codex backend speaking to `codex app-server` over stdio.
The existing Claude SDK backend remains the default and is not rewritten or moved
to ACP. Do not modify `server/src/agent/claude/**` for this integration.

ACP is a separate future transport backend behind the same application interface.
The application must not depend on one vendor's wire protocol. A shared application
interface does not require identical wire transports for every agent.

Why native Codex first: App Server exposes session lifecycle, streaming, steering,
approvals, model discovery and account rate-limit APIs. The existing codex-acp bridge
already wraps App Server, but some rich features depend on experimental extensions
or on its JetBrains AIR client profile. Baseline ACP is not proof of full parity.
Native integration avoids depending on those adapter-specific extensions for the
first complete Codex implementation. No separate OpenAI model API loop is built.

Alternative if the user prefers ACP now: implement a generic ACP backend and a
version-pinned codex-acp profile, explicitly negotiating extensions. Account limits,
background-task controls and every other gap still require a proven implementation;
do not declare AIR compatibility or advertise capabilities without implementing the
corresponding contracts. Revisit the recommendation if a released ACP profile covers
the complete acceptance matrix without provider-specific side channels.

## Confirmed launch and session experience

The user launches `/nb` from an agent CLI. The invoking CLI already determines the
provider. The user also explicitly wants invocation from Codex Desktop. Nota Bene is
a skill, not an independent provider picker. The browser may
switch only between sessions, models and capabilities available from that provider.
There is no Claude/Codex switch inside a running browser window.

- The existing Claude `/nb`, `/nb new`, `/nb fork` skill and its current background-task
  lifecycle remain unchanged. Omitting a provider keeps today's Claude behavior.
- Add a separate Codex-compatible `nb` skill usable from Codex CLI AND local Codex
  Desktop. It invokes the launcher with an explicit Codex provider. Do not reuse Claude
  Skill-tool syntax or Claude plugin variables in Codex instructions. Install it in a
  Codex-specific discovery root so it does not shadow Claude's existing `nb`. Ship it
  with the checkout/package and document installation and the host's actual invocation
  syntax rather than promising every host understands `/nb` literally.
- For Codex CLI, use its available background process/task mechanism and bounded
  readiness checks; stopping the owning task stops that window. Keep Claude's existing
  skill lifecycle unchanged.
- For Codex Desktop, use the launcher's supervised detached mode: finishing the agent's
  response, switching chats or closing its panel does not kill the window. Closing a
  browser tab does not silently terminate work. Explicit stop/server shutdown ends it.
  Repeated invocation focuses the same `(Codex, folder)` window. No resident duplicate
  process per prompt, and no dependency on a short-lived tool shell staying alive.
- Desktop invocation requires local workspace execution. If the invoking environment
  cannot launch a local process, report that clearly; do not silently create a remote
  window or a different provider session. Use the current workspace folder and owning
  Codex thread id for explicit `fork` when the host provides it. Do not guess a thread
  by selecting the last transcript file. If the source cannot be identified, fail
  `fork` clearly rather than opening an unrelated or empty conversation.
- Add `--agent codex` to the standalone launcher/server path as the explicit equivalent;
  default `--agent claude` is backward-compatible. This does not add a provider UI.
- Each window has one fixed provider/backend for its lifetime. Its session picker
  lists only that provider's sessions, retaining project grouping, titles and ordering.
- `/nb` resumes the provider's last Nota Bene session for the folder or starts fresh;
  `new` starts fresh. Explicit `fork` carries the calling conversation into a separate
  provider-native branch so terminal and browser never append to the same transcript.
- Switches retain existing busy/pending-comment protections. Agent restart keeps the
  provider/session; supervised server restart/continue also keeps that identity.
- One window per `(provider, project folder)` permits Claude and Codex to coexist.
  Invoking Codex must not bring an existing Claude window forward instead. Preserve
  legacy Claude lock/registry lookup semantics when entries have no provider field.
- Session controls expose only the selected provider's actual models and permission
  profiles. Display the window's provider as identity, not as a switchable selector.
- Reuse the invoking Codex account/configuration. If authentication is missing/expired,
  offer an explicit sign-in/retry action through App Server; do not parse/copy auth files
  or require API-key creation for ChatGPT login. Preserve configured API-key accounts.
- A missing executable or initialization failure is clear and retryable; the existing
  Claude windows and sessions remain usable.

## Shared integration boundary

Introduce a small startup backend catalog/factory and provider-owned session identity.
The launcher chooses the provider once; HTTP/WebSocket routes retain the existing
single-backend composition. A Codex window never calls Claude history or session APIs.

Preserve the existing single-backend server/test entry point as a compatibility path.
Old client messages and persisted state without a provider mean Claude. New protocol
fields are versioned; old clients must not operate a Codex session under Claude rules.

Capabilities and discovered controls describe the fixed provider and its current
session. Publish them before enabling controls; refresh commands/models/stats on session
switch without changing the window's provider. Keep permission profiles distinct: never map Claude `auto` or `acceptEdits`
to a Codex sandbox/approval combination simply because labels look similar.

Use provider-neutral metadata for tool categories, child conversations and task
controls; preserve legacy Claude rendering and tool names. A shared UI should not
infer Codex subagents solely from Claude's `Agent` or `Task` tool names.

Codex wire types stay inside its adapter. A versioned JSON-RPC transport owns framing,
request ids, handshake, cancellation, timeout/error handling, server-initiated requests
and bounded stderr diagnostics. Start subprocesses with argument arrays, without a
shell. Never expose credentials through messages, logs, URLs or configuration exports.

## State and concurrency

- Provider-qualify new conversation identity, last-session selection, model/mode
  preferences, comment stores and app compaction archives. Keep existing Claude paths
  and state readable without rewriting native Claude transcripts.
- Treat provider session ids as opaque values. Validate the public reference and map
  it safely for storage; do not weaken path checks to accept arbitrary raw ids.
- Codex discovery and replay use its APIs, including pagination. Do not scan Claude's
  `~/.claude/projects` as a fallback for Codex. Select deterministic source-item-based
  message/tool ids so inline anchors survive replay and reopening.
- Session transitions keep generations, permission cancellation, send accounting and
  stale-event rejection. Session switching must not route late events or approval
  answers into the new session. A failed target lookup leaves the current session intact.
- Match every sent message to actual provider acceptance/completion. Steering and turn
  completion races must not duplicate prompts, settle later sends or leave them pending.
- If another client holds a Codex thread, report it and keep the current window usable;
  do not take over or mutate that client's conversation silently.

## Feature preservation and Codex acceptance matrix

Every existing Claude row remains unchanged. Implement the same Nota Bene workflow
for Codex where supported, using a local application implementation where appropriate.

| Existing feature | Codex implementation / acceptance requirement |
| --- | --- |
| Streamed chat, tools, errors and stop | Normalize App Server items/events; reconcile final content without duplicate text. |
| Send while working; force-send | Native steering; interrupt then send for force. Verify completion/steering races. |
| Text/file/media comment batches | Existing batch assembly and attachments; preserve labels, quotes and image ordering. |
| File tree, viewers, markup, branch/worktree views | Existing app services stay available independently of agent transport. |
| `!` shell commands | Existing ShellRunner and safeguards; adapt its delivery to Codex input without changing Claude's formatting. |
| File mentions and suggestions | Codex search when supported; existing bounded local completion fallback. |
| Commands and skills | Discover supported Codex commands/skills; include shared grill-me, Superpowers and lavish. Do not advertise terminal-only actions as working UI commands. |
| CLI/Desktop skill launch/new/fork; browser resume/list/switch/title | Fixed-provider session APIs, stable replay ids, namespace-safe app state and provider-scoped window discovery. |
| Clear | Start a new conversation with existing comment/reset safeguards; do not send unsupported `/clear` text as an ordinary prompt. |
| Manual/automatic compaction and earlier history | Normalize actual boundaries; preserve archived segments and anchors. Idle compaction uses provider-owned settings, not Claude settings. |
| Model, effort and permission controls | Live model/profile discovery; retain confirmed settings per provider; surface refused changes accurately. |
| Context and plan-limit meters | Read token/context data and native account limits; display actual limit-window durations, not hard-coded Claude five-hour/seven-day assumptions. |
| Subagent tabs, including nested children | Normalize observed child-thread associations and read their history without starting another model turn. |
| Background tasks, output and stop | Track actual task/process ids and output; use targeted native controls only where available and negotiated. |
| Pending comments, reconnection, takeover, restart | Existing ownership/auth protocol and replay semantics; tests cover session switches, two-provider window coexistence and failed opens. |
| English/Russian UI | Provider-neutral text plus accurate agent-specific labels, errors and capability explanations. |

### Parity questions that must not be silently hidden

Full feature parity is an acceptance claim, not a consequence of implementing chat.
The following are explicit verification gates before declaring Codex support complete:

- Forcing an existing foreground tool to background: the inspected native API has
  background-terminal list/terminate methods behind experimental API support, but no
  proven equivalent of Claude SDK `backgroundTasks(toolUseId)`. Prove a supported
  implementation or bring this specific gap to the user; do not relabel interrupt as background.
- Prompt prediction: the existing Claude UI can display a native next-prompt suggestion.
  Do not add an extra paid model call merely to imitate this. Verify native support or
  explicitly agree the unavailable behavior with the user before claiming parity.
- Session cost: a ChatGPT account does not imply a meaningful per-session USD amount.
  Show unavailable cost truthfully, preserving available context/limit meters.
- Compaction token counts/duration and child-task observability may be absent in
  provider events. Preserve unknown values rather than fabricating numbers or success.
- Async questions/structured elicitation and rich permission choices must have an
  actual answer path; an unanswered provider request cannot leave a turn hung.

No existing Claude control is removed because Codex lacks a corresponding operation.
An unresolved Codex gate prevents a "full parity" completion claim, and is reported
with the concrete affected workflow for a user decision.

## Verification and delivery

- Establish the existing unit-suite baseline before product changes. Serialize suites
  that share test ports; distinguish sandbox `listen EPERM` from product failures.
- Add contract tests for caller-bound provider selection, same-folder Claude/Codex window
  coexistence, backward-compatible Claude lookup and state isolation. Exercise Codex
  CLI task ownership separately from Desktop detached lifetime and repeated invocation.
- Exercise the Codex transport against a scripted local JSON-RPC process: handshake,
  out-of-order responses, malformed data, disconnects, late events and pending approvals.
- Add event/replay tests for deterministic ids, comments/images, steering/interrupt races,
  compaction, child histories and task lifecycle. Do not require a paid model in unit tests.
- Add UI/E2E coverage with scripted providers. Run the existing Claude suites unchanged.
- Verify a real Codex process with a disposable project/vault/state directory and an
  explicit isolated session, including existing ChatGPT login and a fresh login path.
  Never resume or mutate the conversation controlling this implementation.
- Validate types, UI build and package launch selection, not only development mode.
- Deliver on this feature branch. No merge, deployment or package publication as part
  of this step. Record verified behavior and remaining parity gates concretely.

## Scope boundaries

No Claude backend rewrite, agent/model API reimplementation, ChatGPT web automation,
browser provider switching, automatic cross-provider transcript conversion, general
plugin-management UI or new
cloud runtime. Generic ACP transport remains a separate stage under this recommendation.
Its future addition should reuse the same registry, event contract and capability model.

## Evidence inspected

- Existing `server/src/agent/types.ts`, `shared/src/agent.ts`, protocol, session manager,
  state/target checks, server composition, session picker and model/mode controls.
- Local Codex CLI 0.166.0 stable and experimental generated JSON schemas. Generated
  files remain temporary research artifacts, not a public copy of user configuration.
- [Official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).
- [Official skill discovery/invocation documentation](https://learn.chatgpt.com/docs/build-skills).
- [codex-acp README](https://github.com/agentclientprotocol/codex-acp/blob/main/README.md),
  [steering](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md),
  [AIR extension contract](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md).

Remote main-branch capabilities are evidence for design, not a promise that a released
package or a particular installed Codex version supports every method. Implementation
must pin/verify the supported runtime contract and test capability negotiation.
