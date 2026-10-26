# Nota Bene

A browser IDE over Claude Code: the chat with the agent, inline margin comments on any reply or file (sent as one batch), file tree, media viewer, sessions. Built on the Claude Agent SDK.

## Layout

- Root: the app (React + TypeScript), npm workspaces `shared/`, `server/`, `web/`, plus `e2e/`, `bin/nota-bene.mjs` (launcher) and `skill/` (the `/nb` skill).
- `prototype/` — retired archive (2026-10-26, M5), kept as a reference and no longer changed. See `prototype/CLAUDE.md`.
- `docs/` — notes, specs, plans, the draft feedback to Anthropic.

The local root compat symlinks (`server.mjs`, `public`, `ide.sh`, ...) were removed at the M5 switch-over.

## Rebuild (root)

Node >= 23.6 (the server runs `.ts` directly). From the repo root:

- `/nb`, `/nb new`, `/nb fork` — from Claude Code, via `skill/` (linked as `~/.claude/skills/nb`): open the window for the caller's folder; resume its last session / start fresh / continue this conversation as a branch.
- `nota-bene [dir] [--port N] [--resume ID [--fork]] [--new] [--detach]` (`bin/nota-bene.mjs`) — the launcher the skill uses. One window per folder (a launch takes the folder's lock and gives way to a window already serving it). It supervises the server: exit 75 relaunches at once with `--continue`; 0, 130, 143 exit; anything else is a crash, relaunched after 1 s, giving up at 5 crashes within 60 s. `--detach` prints one line (`opened URL` or `already-open URL`).
- `npm start [-- <dir> --port N --resume ID --continue]` — builds `web/dist`, then serves app + API from the server directly, unsupervised (default port 4777; project = the directory you ran npm from, or the `<dir>` argument, relative to it).
- `npm run dev` — server on 4780 (`node --watch`, with `--allow-origin http://localhost:5173`) + Vite on 5173 (proxies `/info` and `/ws` to the server). Open http://localhost:5173. Dev has its own state dir, `~/.nota-bene-dev` (set `NOTA_BENE_HOME` to override; the prototype import is off), so experiments never touch the working `~/.nota-bene`; the server logs `state: <dir>` at startup.
- `npm test` — unit tests (vitest, ports are 0 / random).
- `npm run e2e` — Playwright, ports 4791-4795. The `files` project uses `ffmpeg` on PATH to generate its media fixtures at startup; without it the media tests are skipped with a message (`NB_E2E_FFMPEG=0` forces that path).

Ports: live windows 4777-4799, skipping 4780 and 4790-4795 when the launcher picks one; dev 4780 (server) and 5173 (Vite); manual smoke 4790; e2e 4791-4795. Never use 4777-4781 for tests while live windows run. `/info.root` tells windows apart.

State lives in `~/.nota-bene/` (override with `NOTA_BENE_HOME`), never in the repo:

- `sessions.json` — last session per project and port
- `prefs.json` — agent permission mode per project dir (`modes[root]`), plus the `importedPrototype` marker of the one-time prototype import
- `comments/<sessionId>.json` — pending and sent margin comments of one agent session
- `attachments/<sha256>.<ext>` — pasted images, content-addressed; only ids travel over the socket
- `windows/<port>.json` — the window registry (`root`, `pid`, `launcherPid`, `startedAt`)
- `locks/<hash>` — per-folder launch locks

Server routes besides the app: `/info`, `/ws`, `/tree`, `/file` (Range; sandboxed headers), `/complete` (`@` search), `/attach` (POST image, GET `/attach/<id>`), `/sources` (this checkout, other worktrees and branches; read-only, `src=` on `/tree` `/file` `/complete`), `/sessions` (all Claude Code sessions with their cwd, for the picker).

Session switch and ↻ are in-process: the server closes the SDK query and resumes (another) session, possibly re-rooting to another project folder; a new session may only start in the current root or in a folder that already has sessions.

Restart semantics: ↻ restarts the agent, not the server process; it stays available while the agent is busy (escape hatch). The ↻ menu also has "Restart the server", shown only when `/info.supervised` is true (the window runs under the launcher): the server exits with code 75 and the launcher relaunches it with `--continue`, so the session resumes. Under `npm start` / `npm run dev` there is no such item.

Smoke hygiene (manual run with the real agent): use a temp `NOTA_BENE_HOME`, a temp `CLAUDE_JOURNAL_VAULT` (or the agent in the temp project follows the global journal protocol and writes into the real vault) and `NOTA_BENE_PROTOTYPE_SESSIONS=off`, on port 4790. Afterwards move the temp projects' transcripts (`~/.claude/projects/-private-tmp-nb-*`) to the Trash, or they clutter the session picker.

## You may be running inside this tool

If the project root is this directory, the chat window you are talking through is most likely served by the rebuild (root); windows started before the M5 switch-over may still be the prototype (check `/info.root` and the header).

Rebuild window:

- Changes to `web/` take effect after `npm run build -w web` and a page reload (tell the user to reload). A launcher restart also rebuilds a stale `web/dist`.
- Changes to `server/` (or `shared/`) need a server restart: ask the user to open the ↻ menu and pick "Restart the server"; the session resumes automatically. **Do not kill, restart or curl your own window's server** — that kills your own turn. Finish the turn first.
- Test server changes on a separate port (4790) with a temp project dir and temp `NOTA_BENE_HOME`, never on a live window's port.

Prototype window (only while some are still running during the transition; the prototype is not changed any more):

- A page reload picks up `public/index.html`; the server needs the **↻ Сервер** button in its header. Do not restart it yourself.
