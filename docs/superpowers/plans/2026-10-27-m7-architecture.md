# M7 Architecture Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Act on the user's architecture review of 2026-10-27 (`docs/architecture.md` §8–9). The milestone has four packages:
- **A — web structure:** UI persistence moves to listener middleware; three large components are split by composition.
- **B — session state machine:** `SessionManager` gets explicit states and small single-purpose parts.
- **C — history after compaction:** the replay starts at the last compaction. «Показать до сжатия» loads the earlier part on demand.
- **D — one tab per window:** a second tab sees «Окно уже открыто в другой вкладке» and can take over («Работать здесь»).

**Architecture:**
- A and B change no behaviour. They are proved by the existing tests plus new characterization tests written first.
- C and D add protocol version 5:
  - `replay.earlier`, `GET /history` (C);
  - `occupied`, `taken-over`, the client message `takeover` and close code 4001 (D).
- Both sit on the new session parts from B.

**Tech Stack:** Node ≥ 23.6 TS (server, `ws`), React 19 + Redux Toolkit 2 (web), vitest, Playwright.

**Spec:** `docs/architecture.md` §8 (the risks) and §9 (the user's rulings). The user's words, 2026-10-27:
- on §8.2: "надо править, делать полноценную систему, иначе всё поедет и полезет туча багов";
- on §8.4: "ограничил бы использование тулы в нескольких вкладках для одной сессии … приложение должно сказать, что уже открыта другая вкладка";
- on §8.5: "сделал бы это сразу после компакта";
- on §8.6: "лучше сразу делать композицию".

The takeover and «Показать до сжатия» designs were proposed in chat and accepted ("Огонь").

**Base:** worktree `~/Documents/Projects/nota-bene-m7`, branch `m7-architecture` from `main`.

## Global Constraints

The M0–M6 rules hold:
- one task is one small commit with the trailer `Task: M7-NN`;
- every UI string goes through `t()` in ru and en;
- tests use ports 4790–4795 only;
- the smoke follows the CLAUDE.md hygiene;
- persistence code (C) gets an independent reviewer;
- check test exit codes directly, never through a pipe into grep.

Behaviour rules:
- **A and B are pure refactors.** No test may change except imports and paths. A test that has to change in meaning is a finding, not a fix.
- **The `SessionManager` type** (`server/src/session.ts`) and its use in `server/src/server.ts` stay as they are through B. C and D may add members.
- **The user works in the app.** A web change reaches them after `npm run build -w web` and a reload. A server change needs "Restart the server" after the CLAUDE.md pre-check.

**Rulings:**

**History (C)**
- **R-M7-1. The SDK cannot give back the conversation before a compaction.** Checked 2026-10-27 on a real transcript: 6 `compact_boundary` entries in the file, yet `getSessionMessages` returned 90 messages starting from the compaction summary, and no option of SDK 0.3.310 returns more. So the earlier part is kept by us:
  - at each `compact_boundary` the server cuts the hub history before the boundary;
  - it appends the cut part as one segment to its own archive, `~/.nota-bene/history/<sessionId>.jsonl`, one JSON line per segment: `{"segment":n,"events":[…]}`;
  - `stream_event` frames are dropped from the archive, because a replay never needs them (the transcript replay has none either).
- Reading the CLI's `.jsonl` directly is rejected. It is a private format, the same risk as §8.1.
- Consequence: compactions done outside Nota Bene (the plain CLI) have no archive, and the button is not shown for them.
- **R-M7-2. The cut keeps the `compact_boundary` frame itself**, so the "compacted" marker stays the first item. The `/compact` user event before it goes to the archive.
- **R-M7-3. `/clear` starts a new conversation id:** the replay has `earlier: false`. The old id's archive stays on disk; switching back to that session offers it again.
- **R-M7-4. «Показать до сжатия» loads one segment per click,** newest first: `GET /history?session=<id>&before=<n>` → `{events, segment, more}`.
  - **Before it is loaded,** a sent comment whose message is in an unloaded segment is labelled `srcBeforeCompact` in its card. It is not labelled "orphan", and it has no jump.
  - **After it is loaded,** the highlight resolves as usual.

**One tab (D)**
- **R-M7-5. The server decides.** The first socket is the owner. A later socket gets `{kind:'occupied'}` plus `hello`: no replay and no state frames, and its messages other than `takeover` are ignored.
  - On `takeover`, the server sends the owner `{kind:'taken-over'}`, closes it with code 4001, then attaches the new socket as on a normal connect (replay, state frames, `hello`).
- **R-M7-6. Reload race.** When a socket arrives while an owner exists, the server waits up to `TAKEOVER_GRACE_MS = 700` for the owner to close before answering `occupied`. A reloading tab's old socket closes within that time in practice.
- **R-M7-7. Zombie owner (sleep, dead network).** The server pings the owner every `HEARTBEAT_MS = 30_000` and terminates it when the previous ping got no pong. «Работать здесь» works regardless.
- **R-M7-8. The client stops reconnecting on close code 4001.**
  - The taken-over tab shows «Открыто в другой вкладке» and a «Работать здесь» button. The button reconnects and sends `takeover` once `occupied` arrives.
  - The occupied tab shows «Окно уже открыто в другой вкладке» and the same button.
  - Both are one full-window overlay component; under it the app stays mounted but inert.
- **R-M7-9. Tests.** `startServer` gets `oneTab?: boolean`, default `true`; `main.ts` uses the default.
  - Server unit tests that check broadcasting to several sockets pass `oneTab: false`.
  - The e2e tests that open a second page (`e2e/comments.spec.ts:239`, `e2e/controls.spec.ts:106`, `:339`) become takeover flows or are rewritten to one page. Any assertion they lose is listed in the task report.
- **R-M7-10. A protocol-4 page (a cached old bundle) against a new server** would show an empty app on `occupied`. This is accepted, because a reload fixes it.

**State machine (B)**
- **R-M7-11. The parts and their owners**, all under `server/src/session/`; `session.ts` stays the façade that wires them:

| Part | File | Owns today's |
|---|---|---|
| `Phase` | `phase.ts` | `switching`, `closed` |
| `TurnLedger` | `turns.ts` | `waiting`, `commandIds`, `clearSent`, `clearResultDue`, `compactedInTurn` |
| `PermissionBroker` | `permissions.ts` | `pending`, `askFor` |
| `TitleTracker` | `title.ts` | `title`, `titleAt`, `titleTimer`, `fetchTitle`, `scheduleTitle` |
| `AgentSlot` | `agentSlot.ts` | `agent`, `loop`, `gen`, `ensureAgent`, teardown |

  `forkPending`, `sessionId`, `root`, `mode` and `model` stay in the façade.

## Review Focus

1. **The owning tab is reloaded.** It must come back as the owner, without the occupied overlay flashing. Test in M7-10: e2e reloads the page twice and expects no overlay.
2. **A compaction lands in the middle of a live turn** (auto-compact while the agent works, idle compaction). Frames after the boundary stay in the replay, and `busy` and `waiting` are unaffected. Test in M7-07.
3. **A sent comment on a message that went into the archive** must not read as orphaned or deleted. Test in M7-08.
4. **A takeover while a switch or a turn runs.** Ownership is independent of the session: the new tab gets the current replay and the `switching` and busy state. Test in M7-09: a takeover during a fake turn shows the turn running.
5. **Server restart after a compaction.** The replay comes from the transcript (post-compaction), and `earlier` is true when the archive has segments for that id. Test in M7-07.

---

## Package A — web structure

### M7-01: UI persistence on listener middleware (§8.3)

**Files:**
- Create: `web/src/store/persist.ts`
- Modify: `web/src/store/store.ts` (remove the `store.subscribe` block)
- Test: existing `web/src/store/*.test.ts*`, `web/src/tabs/*.test.ts*`, `web/src/files/RecentFiles.test.tsx` (unchanged)

**Interfaces:**
- Produces: `persistListeners(lm: ListenerMiddlewareInstance<RootState>): void`, registered in `makeStore` on its own listener middleware (prepended next to `controlsListener`).

One listener per concern, each with a `predicate` comparing `original` against current state:
- `panel:comments`;
- `panel:tree`;
- `tree:<root>[:<src>]` dirs;
- `tabs:<root>`;
- the recent-file dwell (`RECENT_DWELL_MS`, cancelled by the next active change through `cancelActiveListeners`);
- the root change: on `serverEvent` with `kind:'session'` and a root different from `tabs.root`, call `clearRefCache` (not on the first root), `loadSources(!first)`, then dispatch `enterRoot` with the saved tabs and dirs read before the dispatch.

- [ ] Write `persist.ts` and remove the subscriber; there must be no `store.subscribe` left in `store.ts`.
- [ ] `npm test -w web` — all pass, with no test file edited.
- [ ] `npx tsc -b` — exit 0.
- [ ] Commit `refactor(web): UI persistence as listener middleware` with `Task: M7-01`.

### M7-02: FileTree by composition (§8.6)

**Files:**
- Create: `web/src/files/tree/useTreeEntries.ts` (entries, loading, failed, `track`, merged `refresh`, `missedTurn`, `shownIn`)
- Create: `web/src/files/tree/useExpandAll.ts` (BFS, `EXPAND_CAP`, `EXPAND_FETCHES`, `NO_EXPAND`)
- Create: `web/src/files/tree/TreeHeader.tsx`, `web/src/files/tree/TreeRow.tsx`
- Modify: `web/src/files/FileTree.tsx` (composition only)

**Interfaces:**
- Produces: `FileTree` and `EXPAND_CAP` keep their exports and paths (`EXPAND_CAP` re-exported).
- Limit: no file over 200 lines.

- [ ] Move code, no logic edits.
- [ ] `npm test -w web` and `npx tsc -b` pass, with no test file edited.
- [ ] Commit with `Task: M7-02`.

### M7-03: FileView by composition (§8.6)

**Files:**
- Create: `web/src/files/view/useFileLoad.ts` (the HEAD / Range probe / GET sequence, `rev`, `bust`, `failed`, `reloadMedia`, version dispatch)
- Create: `web/src/files/view/useMediaMarkup.ts` (`markable`, `markPopup`, `onMarkAdd`, `markAdded`, `saving`)
- Create: `web/src/files/view/CodeText.tsx`, `TextBody.tsx`, `MediaBody.tsx`
- Modify: `web/src/files/FileView.tsx`

Same rules as M7-02: exports stay, files ≤ 200 lines, no test edited. Commit with `Task: M7-03`.

### M7-04: CommentCard by composition (§8.6)

**Files:**
- Create: `web/src/comments/card/useCommentSource.ts` (`sourceState`, orphan detection, `itemRoot`/`fileRoot`)
- Create: `web/src/comments/card/CardActions.tsx` (`IconButton` and the action row)
- Create: `web/src/comments/card/CommentCardPopover.tsx` (with `usePopoverPlacement`)
- Modify: `web/src/comments/CommentCard.tsx`

Same rules as M7-02: exports stay, files ≤ 200 lines, no test edited. Commit with `Task: M7-04`.

## Package B — session state machine

### M7-05: Characterization tests for SessionManager

**Files:**
- Create: `server/src/session.characterization.test.ts`

Write one test per scenario below that is not already pinned by `session.test.ts`, `switch.test.ts` or `commands.test.ts`. The report lists, per scenario, the existing test name or the new one. All against the fake backend and today's code, so they pass before any refactor:
1. A send during a switch returns `'switching'`; nothing is emitted.
2. A switch while a send waits is refused with `SwitchError('switch')`; a restart while it waits interrupts, then resumes the same id.
3. A permission asked by the old agent after `gen++` resolves `false` and is never emitted.
4. `/clear`: the reset empties the hub; the following result is not stored; the new id is saved; the id listeners get `(new, old)`.
5. A `/compact` result never arms idle compaction; a normal turn's result does; a turn containing `compact_boundary` does not.
6. `command_lifecycle` `cancelled` drops that id from `waiting`.
7. The agent's loop ends without close → an error result answers every waiting send; `busy()` is false after it.
8. A fork: the source id is never written to `sessions.json` before the first init names the new id; a restart before that init keeps forking.
9. `setMode` during a switch answers with the current mode and its ack; it does not apply.
10. `close()` during a switch: no agent is started afterwards.
11. A forced send interrupts first, then sends with priority `'now'`; two sends keep their order.
12. A title lookup that answers after a switch is dropped.

- [ ] Write the tests and run `npx vitest run server/src/session.characterization.test.ts` — all pass on the unchanged code.
- [ ] Commit `test(server): characterize SessionManager before the state machine` with `Task: M7-05`.

### M7-06: Explicit state machine (R-M7-11, §8.2)

**Files:**
- Create: `server/src/session/phase.ts`, `turns.ts`, `permissions.ts`, `title.ts`, `agentSlot.ts`, each with its own `*.test.ts`
- Modify: `server/src/session.ts` (the façade)

**Interfaces** (exact; later tasks use them):

```ts
// phase.ts
export type PhaseKind = 'live' | 'switching' | 'closed';
export class Phase {
  get kind(): PhaseKind;
  /** live → switching; throws SwitchError('switch', 'a switch is already in progress') when switching; no-op returning false when closed */
  beginSwitch(): boolean;
  /** switching → live (or stays closed) */
  endSwitch(): void;
  /** any → closed; final */
  close(): void;
}
// turns.ts
export class TurnLedger {
  sent(id: string, o?: { command?: 'compact' | 'clear' }): void;
  /** applies a result frame: `store` false for a /clear's own result, `arm` whether idle compaction should arm */
  result(f: { user_message_uuid?: unknown; user_message_uuids?: unknown; is_error?: unknown }): { store: boolean; arm: boolean };
  cancelled(id: string): void;
  compactBoundary(): void;
  /** a conversation_reset: clears waiting; the next result is a /clear's own when a /clear was sent */
  reset(): void;
  /** a real user send follows: the next result is a normal one */
  userTurn(): void;
  waiting(): number;
  clear(): void;
}
// permissions.ts
export class PermissionBroker {
  constructor(o: { emit: (ev: EmitInput) => void });
  ask(gen: () => number, g: number): PermissionAsk;
  answer(id: string, allow: boolean): void;
  pending(): number;
  denyAll(): void;
}
// title.ts
export class TitleTracker {
  constructor(o: { lookup: (id: string, dir: string) => Promise<string | null | undefined>; onChange: () => void });
  get title(): string | null;
  afterResult(id: string, dir: string, gen: number, currentGen: () => number): void;
  load(id: string, dir: string): Promise<void>;
  reset(): void;
  stop(): void;
}
// agentSlot.ts
export class AgentSlot {
  constructor(o: { start: (g: number) => AgentSession; pump: (a: AgentSession, g: number) => Promise<void> });
  get gen(): number;
  get agent(): AgentSession | null;
  isCurrent(a: AgentSession, g: number): boolean;
  /** throws when the phase is not live */
  ensure(phaseLive: boolean): AgentSession;
  /** gen++, close the agent, wait for its loop up to `waitMs` */
  teardown(waitMs: number): Promise<void>;
  died(a: AgentSession): void;
}
```

`busy()` becomes `phase.kind === 'switching' || turns.waiting() > 0 || permissions.pending() > 0`. An illegal transition throws, and it is a test failure, never caught silently.

- [ ] Write each part with its unit test first (red), then the part (green).
- [ ] Rewire `session.ts` onto the parts; `session.ts` ≤ 350 lines.
- [ ] Full `npm test` (exit 0); M7-05's file unchanged and green; `npx tsc -b` exit 0.
- [ ] Independent review on the most capable model: the diff, plus the M7-05 scenarios mapped to the new code.
- [ ] Commit with `Task: M7-06`.

## Package C — history after compaction

### M7-07: Server archive and `/history` (R-M7-1…4)

**Files:**
- Create: `server/src/archive.ts`, `server/src/archive.test.ts`
- Modify: `server/src/hub.ts` (`cut(index)`), `server/src/session.ts` (at `compact_boundary`), `server/src/server.ts` (route), `shared/src/protocol.ts` (`PROTOCOL = 5`, `replay.earlier?: number`), `server/src/system.ts` (storage size of `history/`; the clean action removes archives whose transcript is gone)

**Interfaces:**
- `EventHub.cut(): ServerEvent[]` removes and returns the history before the last stored `compact_boundary` frame (the frame stays).
- `EventHub.reset(events, o?: { earlier?: number })` and the connect replay carry `earlier` (the number of archived segments) when > 0.
- `HistoryArchive({ dir })`, with these methods:
  - `append(sessionId, events): number` — returns the new segment number, starting at 1; drops `stream_event` frames; one fsync'd line per segment;
  - `count(sessionId): number`;
  - `segment(sessionId, n): ServerEvent[] | null`.
  - Ids are checked against the session-id pattern; a corrupt line is skipped and reported once.
- `GET /history?session=<id>&before=<n>` → `200 {events, segment, more}` for segment `n-1`.
  - 404 when there is none.
  - 409 when `session` is not the current id; only the current session's archive is served.

Tests (named):
- `cut keeps the boundary and later frames`;
- `a compaction mid-turn keeps waiting and busy`;
- `stream_event frames are not archived`;
- `restart after a compaction replays the transcript with earlier = count`;
- `/clear replays with no earlier`;
- `history 409 for another session`;
- `corrupt archive line is skipped`.

Steps:
- [ ] Red, green, full `npm test` exit 0, `npx tsc -b` exit 0.
- [ ] Independent review (persistence).
- [ ] Commit with `Task: M7-07`.

### M7-08: «Показать до сжатия» in the feed (R-M7-4)

**Files:**
- Modify: `web/src/store/feed.ts` (`earlier: number` in `FeedState`, set from `replay.earlier`; action `historyPrepended({events, segment, more})` reduces `events` from `emptyFeed` and prepends the items)
- Create: `web/src/feed/EarlierButton.tsx` (first item of the feed when `earlier > 0`; loading and error states; strings `earlierShow` «Показать до сжатия» / "Show before compaction", `earlierLoading`, `earlierFailed`, `srcBeforeCompact` «до сжатия» / "before compaction")
- Modify: `web/src/comments/card/useCommentSource.ts` (a sent comment whose message is absent while `earlier > 0` → `srcBeforeCompact`, no jump)
- Test: `feed.test.ts` (`historyPrepended keeps live state`), `EarlierButton.test.tsx`, a card test for `srcBeforeCompact`

Steps:
- [ ] Red, green.
- [ ] `npm test -w web` exit 0.
- [ ] Commit with `Task: M7-08`.

## Package D — one tab per window

### M7-09: Server ownership and takeover (R-M7-5…7, R-M7-9)

**Files:**
- Modify: `server/src/server.ts` (owner, grace, heartbeat, `takeover`), `shared/src/protocol.ts` (`occupied`, `taken-over`, `takeover`), `server/src/hub.ts` only if needed
- Modify: server tests that need several sockets (`oneTab: false`)
- Create: `server/src/onetab.test.ts`

Tests (named):
- `second socket gets occupied and no replay`;
- `occupied socket's send is ignored`;
- `takeover closes the owner with 4001 and replays to the new one`;
- `owner closing within the grace makes the newcomer the owner`;
- `owner with no pong is terminated`;
- `takeover during a turn shows the turn running`;
- `/info.clients counts the owner only`.

Steps:
- [ ] Red, green, full `npm test` exit 0.
- [ ] Commit with `Task: M7-09`.

### M7-10: Occupied and taken-over screens (R-M7-8)

**Files:**
- Modify: `web/src/net/socket.ts` (no reconnect after 4001; `reconnect()` export)
- Modify: `web/src/store/store.ts` (`ConnState` gains `'occupied' | 'taken'`; thunk `takeOver()`)
- Create: `web/src/shell/OneTab.tsx` (full-window overlay; strings `occupiedTitle` «Окно уже открыто в другой вкладке», `takenTitle` «Открыто в другой вкладке», `workHere` «Работать здесь», en equivalents)
- Modify: the e2e specs named in R-M7-9
- Create: `e2e/onetab.spec.ts` (second page sees the overlay; «Работать здесь» moves the session; the first page shows taken; a double reload of the owner shows no overlay)

Steps:
- [ ] Red, green.
- [ ] `npm test` and `npm run e2e` exit 0.
- [ ] Commit with `Task: M7-10`.

### M7-11: Final review, merge and smoke

- [ ] Whole-branch review on the most capable model.
- [ ] Fix the findings; scoped re-review.
- [ ] Fast-forward `main`; `npm run build -w web`.
- [ ] Pre-check per CLAUDE.md, then ask the user for "Restart the server" and verify the pid changed.
- [ ] Smoke with the user:
  - a second tab and «Работать здесь»;
  - a reload of the owner;
  - `/compact`, then a reload, then «Показать до сжатия»;
  - a server restart after a compaction.
- [ ] Update `docs/architecture.md` §3–§5 and §8 to the new state; update `CLAUDE.md` (state dir `history/`, the `/history` route, one tab per window).
