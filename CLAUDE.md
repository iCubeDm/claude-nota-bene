# Nota Bene

A browser IDE over Claude Code: the chat with the agent, inline margin comments on any reply or file (sent as one batch), file tree, media viewer, sessions. Built on the Claude Agent SDK.

## Layout

- `prototype/` — the working spike (plain Node + one HTML file, no build). Feature reference for the rebuild and the tool in daily use right now. See `prototype/CLAUDE.md`.
- Root — the real project (React + TypeScript): npm workspaces `shared/`, `server/`, `web/`, plus `e2e/`. See "Rebuild (root)" below.
- `docs/` — notes, including the draft feedback to Anthropic.

The root also holds **local, uncommitted symlinks** (`server.mjs`, `public`, `ide.sh`, `skill`, `node_modules`, `.sessions.json` → `prototype/…`, listed in `.git/info/exclude`). Servers launched before the move still use the old paths. Delete them once every window has been relaunched from `prototype/ide.sh`.

## Rebuild (root)

Node >= 23.6 (the server runs `.ts` directly). From the repo root:

- `npm run dev` — server on 4780 (`node --watch`, with `--allow-origin http://localhost:5173`) + Vite on 5173 (proxies `/info` and `/ws` to the server). Open http://localhost:5173.
- `npm test` — unit tests (vitest, ports are 0 / random).
- `npm run e2e` — Playwright, ports 4791-4793.
- `npm start [-- <dir> --port N --resume ID --continue]` — builds `web/dist`, then serves app + API from the server (default port 4777; project = the directory you ran npm from, or the `<dir>` argument, relative to it).

Ports: 4777 real use, 4780 dev server, 5173 Vite, 4790 manual smoke, 4791-4793 e2e. Never use 4777-4779 for tests while live windows run.

State lives in `~/.nota-bene/` (override with `NOTA_BENE_HOME`), never in the repo.

## You may be running inside this tool

If the project root is this directory, the chat window you are talking through is served by `prototype/`.

- Changes to `prototype/public/index.html` take effect when the user reloads the page — tell them to reload.
- Changes to `prototype/server.mjs` need a server restart. **Do not restart, kill or curl `/restart` / `/switch` yourself** — that kills your own turn. Finish the turn and ask the user to press **↻ Сервер** in the header; the session resumes automatically.
- Before finishing a change to `prototype/server.mjs`, run `node --check prototype/server.mjs`: a syntax error means the window will not come back after ↻, and the user has to relaunch from a terminal.
- Test server changes on a separate port (4790) with a temp project dir, never on a live window's port.
