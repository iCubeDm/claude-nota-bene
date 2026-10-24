# Nota Bene

A browser IDE over Claude Code: the chat with the agent, inline margin comments on any reply or file (sent as one batch), file tree, media viewer, sessions. Built on the Claude Agent SDK.

## Layout

- `prototype/` — the working spike (plain Node + one HTML file, no build). Feature reference for the rebuild and the tool in daily use right now. See `prototype/CLAUDE.md`.
- Root — the real project (React + TypeScript), being planned. Nothing here yet besides docs.
- `docs/` — notes, including the draft feedback to Anthropic.

The root also holds **local, uncommitted symlinks** (`server.mjs`, `public`, `ide.sh`, `skill`, `node_modules`, `.sessions.json` → `prototype/…`, listed in `.git/info/exclude`). Servers launched before the move still use the old paths. Delete them once every window has been relaunched from `prototype/ide.sh`.

## You may be running inside this tool

If the project root is this directory, the chat window you are talking through is served by `prototype/`.

- Changes to `prototype/public/index.html` take effect when the user reloads the page — tell them to reload.
- Changes to `prototype/server.mjs` need a server restart. **Do not restart, kill or curl `/restart` / `/switch` yourself** — that kills your own turn. Finish the turn and ask the user to press **↻ Сервер** in the header; the session resumes automatically.
- Before finishing a change to `prototype/server.mjs`, run `node --check prototype/server.mjs`: a syntax error means the window will not come back after ↻, and the user has to relaunch from a terminal.
- Test server changes on a separate port (4790) with a temp project dir, never on a live window's port.
