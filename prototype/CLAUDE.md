Retired on 2026-10-26 (M5). Archive and reference only — do not change. The app is the repo root.

# Nota Bene — prototype

Throwaway spike: optimized for learning what is convenient, not for polish or tests. It stays the feature reference for the React rebuild at the repo root.

- `server.mjs` — Node server: one long-lived SDK `query()` with streaming input, WebSocket to the page, `/file` (Range) and `/tree` scoped to the project dir, `/complete` (@-mentions via the CLI's `file_suggestions`), `/restart`, `/sessions` + `/switch` (session picker: rewrites `.sessions.json`, then restarts like `/restart`), permission modes (`setPermissionMode`, kept per port).
- `public/index.html` — the whole UI in one file (no build): tabs (chat + files), file tree, comments panel, markdown/mermaid/svg/media rendering, image attachments, prompt suggestions, mode pill, state favicon.
- `ide.sh` — launcher; relaunches with `--continue` on exit code 75 (↻ / session switch) and after crashes.
- `skill/` — the `/nb` Claude Code skill (symlinked as `~/.claude/skills/nb`): `open.sh` starts `ide.sh` on the caller's cwd on a free port 4777–4799 (or brings up the window already serving it), resuming the folder's last window session from `.sessions.json`; `/nb new` starts fresh; `/nb fork` passes the caller's session id as `--resume <id> --fork`.
- UI strings live in the `STR` dictionary (ru, en) in `index.html`; add every new user-visible string to both.
- `.sessions.json` is local state (session per project dir, `_root:<port>`, `_mode:<port>`), never committed.
