# M6 Workspace & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Act on the user's first-day review of the rebuild (2026-10-26). The milestone has three packages:
- **A — polish:** restores what the prototype did better.
- **B — workspace:** an IntelliJ-style frame. It adds tool strips, tab overflow, recent files, hotkeys and file-type icons.
- **C — settings:** a Settings tab for everything outside a session.

M2 (agents) comes after this milestone and lives on the new right strip.

**Spec:** `docs/superpowers/specs/2026-10-24-nota-bene-rebuild-design.md` (Follow-ups). The user's comments are quoted in each task. The prototype is the reference for look and feel (`prototype/public/index.html`, read only).

**Base:** branch `m6-workspace` from `main`.

## Global Constraints

The M0–M5 rules hold:
- one task is one small commit with the trailer `Task: M6-NN`;
- every UI string goes through `t()` in ru and en;
- tests use ports 4790–4795 only;
- the smoke follows the CLAUDE.md hygiene.

The user works IN the app. A `web/` change reaches them after `npm run build -w web` and a page reload. A `server/` change needs "Restart the server", after the check described in CLAUDE.md.

**Rulings from the review:**

**Colour**
- **R-M6-1.** Restore the prototype's accent orange, `oklch(0.70 0.20 60)`, as a distinct token `--nb-accent`.
  - Cause: shadcn uses `accent` for its grey hover background, and that collision turned every prototype accent grey.
  - Every prototype use of `var(--accent)` maps to `--nb-accent`.

**Sizing**
- **R-M6-2.** ~~Content width is relative to the viewport~~ (revised by the user, 2026-10-26, once panels docked): prose (chat, md) keeps the prototype's 860 px; code is up to 256 characters a line. Both leave a 1.5rem margin in a narrow column.
- Media is centred and fitted to the pane: `max-width:100%; max-height: calc(100% - margin)`. A click toggles natural size.

**Strips and tabs**
- **R-M6-3.** Two thin tool strips, IntelliJ-style (user, 2026-10-26: panels are DOCKED and narrow the middle column, open by default; strips and panels run the full height under the header):
  - the left one holds Files (later Structure);
  - the right one holds Comments (later Agents, M2).
  - Clicking an icon toggles that panel.
  - The header's Comments button goes away.
- **R-M6-4.** Settings is a TAB, like a file tab. It opens from a ⚙ button next to the language toggle.

**Hotkeys (R-M6-5)**

Chrome reserves Cmd/Ctrl+W/T/1–9 and Ctrl+Tab, so the bindings are:

| Key | Action |
|---|---|
| Alt+W | close tab |
| Alt+Shift+T | reopen closed tab |
| Alt+←/→ | previous/next tab |
| Alt+1…9 | tab N (1 = chat) |
| Cmd/Ctrl+E | recent files + search |
| Cmd/Ctrl+Shift+F | toggle Files |
| Cmd/Ctrl+Shift+C | toggle Comments |
| Alt+F1 | reveal the current file in the tree |
| `/` or Esc on empty space | focus the composer |

The hotkey list appears in the `?` help.

---

## Package A — polish

### M6-01: Colours back (R-M6-1)
- [ ] Add `--nb-accent` to `web/src/theme.css`, plus a Tailwind token (`nb-accent`).
- [ ] Audit every place where the prototype used `--accent`:
  - comment card quote stripe;
  - user-bubble comment quotes;
  - file-ref underline;
  - quick-label chips' hover;
  - the "working" dot;
  - pending badge tones.
  Map each one.
- [ ] Compare the markdown palette against prototype `.md` rules: inline code colour, links `--primary`, headings, blockquote, hljs theme. Restore the differences, and keep them subtle.
- [ ] Test: a computed style for the comment quote stripe uses the accent; a contrast check.
- [ ] Report: a short before/after list.

### M6-02: Selection button appears in place
- [ ] The 💬 button must not animate its position. Remove `transition-all` (shadcn Button) for `left/top`, or set the position before the first paint (it is rendered hidden until positioned). Test this.

### M6-03: Meters and footer buttons
- [ ] Tooltip colours as in the prototype: popover background, 11.5 px, muted text.
- [ ] Tooltips trigger over the whole button, compact/clear included (wrap the disabled buttons).
- [ ] Restore the prototype's compact and clear icons (copy the SVG paths from `prototype/public/index.html`).

### M6-04: Widths and media fit (R-M6-2)
- [ ] Chat and md use the prose width; code uses the code width (centred card).
- [ ] Panes get the same grid background as the chat (user: "серый фон … отсутствует").
- [ ] Images and video fit the pane; a click toggles natural size. Audio stays as it is (the user likes it).
- [ ] Tests: computed widths at 1440 and 2560 viewports, using jsdom style checks or e2e.

### M6-05: `:` emoji picker in the composer
- [ ] Mount the ShortcodePicker on the composer. Keep the Esc/Tab/Enter contracts with the `@` picker and the suggestion Tab.
- [ ] Test this, plus a real-keyboard e2e (`keyboard.type(':smi')`).

### M6-06: Markdown in user messages and comments
- [ ] User bubbles and comment text (cards, batch details) render through `Markdown` (sanitised).
- [ ] Anchors on user messages still work: the text model comes from the rendered DOM, like replies. Re-anchoring old comments on user messages uses the quote fallback; test it.

### M6-07: Quick labels: emoji only
- [ ] The popup chips and card label chips show only the emoji. The label text moves to a tooltip and an aria-label.

### M6-08: Git branch in the header
- [ ] The header shows the path followed by `(main ✔)`, or `(feature/x ✗)` when there are uncommitted changes.
- [ ] Server: `/sources` (or `/info`) adds `here: { branch, dirty }`. Use `git status --porcelain`, `-c core.fsmonitor=false`, the hardened git env, cached for 5 s. It is refreshed after each live turn.
- [ ] If the folder is not a repo, show nothing.

## Package B — workspace

### M6-09: Tool strips (R-M6-3)
- [ ] The left strip, about 36 px, holds the Files icon (and later Structure). The right strip holds the Comments icon with its pending badge (and later Agents).
- [ ] The panels dock next to their strip. The open state is persisted.
- [ ] The header's Comments button is removed. The Files header button from today's fix is removed too: the strip replaces it.

### M6-10: Tree header actions
- [x] Next to ↻ in the tree header, add three buttons:
  - "Reveal current file" (the IntelliJ "Select Opened File");
  - "Collapse all";
  - "Expand all". It expands the loaded folders and lazy-loads one level at a time, with a cap of 2000 rows. Ruling (2026-10-26): "Expand all" never opens `node_modules` or `.git` (they would eat the cap before the project's own folders; a click still opens them).
- [x] Remove "Reveal in tree" from the tab context menu (the user: it belongs in the tree header).

### M6-11: File-type icons
- [x] Use a small built-in icon set by extension and well-known names, in the tree, tabs, the `@` picker and Cmd+E:
  - `.ts/.tsx/.js/.mjs/.json/.md/.css/.html/.py/.sh/.yml/.toml`;
  - images, video, audio;
  - `package.json`, `README`, `.gitignore`, `Dockerfile`;
  - folders, closed and open.
- [x] The icons are coloured as in IntelliJ, inline SVG, with no new dependency. If a third-party set is used, it must be MIT-licensed, vendored, and have its licence noted.

### M6-12: Tab overflow, IntelliJ-style
- [ ] No horizontal scrollbar. The wheel scrolls the strip, and the active tab scrolls into view.
- [ ] A "▾" button on the right lists the hidden tabs (and all tabs), with search.

### M6-13: Recent files (Cmd/Ctrl+E)
- [ ] A modal with the recently opened files of this root (persisted, up to 50) and a search field. An empty query shows the recent files; typing searches the whole project through `/complete`.
- [ ] Keys: ↑↓ Enter Esc.
- [ ] File-type icons.

### M6-14: Hotkeys (R-M6-5)
- [ ] One keymap module (no scattered listeners) that respects the Esc protocol and text fields: Alt combos work in fields, `/` does not.
- [ ] The `?` help lists every hotkey.
- [ ] Tests for each binding.

## Package C — settings

### M6-15: Settings tab (R-M6-4)
- [ ] ⚙ next to the language toggle opens a `settings` tab. It is unique and cannot be pinned twice.
- [ ] Sections:
  - **Windows:** every running Nota Bene window, from the registry + `/info` + a prototype port scan. Each row has folder, session title, port, uptime, tab connected or headless, and busy, with the actions open / restart agent / restart server / stop. Stop asks for confirmation and refuses the current window.
  - **Storage:** sizes of `attachments/` and `comments/`. "Clean unreferenced attachments" deletes attachments that no comment, session transcript or open draft references. It shows a dry-run count first and moves the files to `~/.nota-bene/trash/` rather than deleting them.
  - **Defaults:** language; the default permission mode for new projects.
  - **About:** version (the git describe of the repo), state dir, log paths.
- [ ] Server routes `/system/windows`, `/system/storage` (GET) and `/system/storage/clean` (POST, Origin-checked).
- [ ] Stopping another window goes through that window's own `/restart-server`-style route (`POST /shutdown`, Origin-checked, only for the same user's windows on 127.0.0.1). It never kills a pid directly.

### M6-16: e2e and real smoke
- [ ] e2e for the strips, tab overflow, Cmd+E, the hotkeys and the Settings tab.
- [ ] A smoke in the user's real window happens after the merge: the user reloads, and we go through the list together.
