# Feedback: a browser "review-first" chat built on the Claude Agent SDK

**TL;DR.** I built a small browser UI over the Claude Agent SDK (TypeScript, v0.3.x). The goal was to work with Claude Code as I do in the terminal, with three additions: inline comments on any part of the conversation or project files, sending comments as a batch, and media and diagrams shown in place of ASCII. The tool is a throwaway spike: one Node server (~300 lines) plus one HTML file (~900 lines), no build step. It is good enough that I now drive Claude Code through it daily. Below: why I built it, what it does, how it handles files and media, and the SDK friction I hit.

## Why

In the terminal TUI, giving precise feedback on a long answer is awkward. I end up quoting fragments by hand, and the answer scrolls away. Plannotator's inline annotation UX (select text, leave a comment, send) works very well for plans. I wanted that UX for the whole conversation: every reply, every file the agent touches. I also wanted it to stay the same agent, with my settings, skills, plugins, hooks, MCP servers and subagents. The Agent SDK made this possible without wrapping the TUI in a PTY.

## Main features

**Chat = the real Claude Code**
- One long-lived `query()` with streaming input. User settings, CLAUDE.md, skills, plugins, hooks and MCP servers load as in the CLI.
- **Messages sent while the agent is busy go in mid-turn**, as in Claude Code, via `priority: 'next'`. "Force send" calls `interrupt()` and starts a new turn with `priority: 'now'`. A Stop button is next to Send.
- Tool-permission requests show up as cards in the chat.

**Inline comments (Plannotator-style)**
- Select any text: an agent reply, your own message, or an open file. Leave a comment with ⌘/Ctrl+Enter.
- Comments collect in a side stack. You edit or delete them inline, then send them all as **one structured message** that includes the quoted fragments and where they came from.
- Comments appear as soft yellow rounded marks. These are overlay boxes from `Range.getClientRects()`, because CSS `::highlight()` can't round corners. Clicking a mark opens the same card as in the stack, so you can edit in place.
- After sending, the marks stay visible in a dimmer style, so you can see what you already gave feedback on.

**Sessions**
- Session picker, like `claude --resume` but visual. It lists sessions from every project, grouped by folder, with a filter. You can continue a session you started in the terminal, or start a new one in any folder.
- The tab title is the session title. A browser window shows which conversation it holds.
- Switching sessions restarts the server process (the supervisor relaunches it with `--continue`), and history is replayed via `getSessionMessages`.

**Status and control in the footer**
- Context meter from `getContextUsage()` and plan limit meters for 5h and week, color-coded.
- Compact (`/compact`) and Clear (`/clear`) are icon buttons. Clear resets the visible transcript when `conversation_reset` arrives.

**Self-hosting**
- The tool can be pointed at its own source. Claude edits the UI from inside the UI, then I reload the page (or press "restart server" for server changes), and the session continues where it left off.

## Working with files and media

This was the most valuable part for me. I use Claude Code for a mixed-media creative project: an animated short with reference images, generated video shots, voice-over audio and Markdown scripts.

- **File tree in an overlay sheet.** It is collapsible and doesn't resize the chat. Files open as tabs next to the pinned chat tab.
- **Built-in viewer.** Images, video and audio play directly; video seeking works through HTTP Range. Markdown and code are rendered, and you can comment on them like chat text. For a creative project this replaced jumping between Finder, Preview and QuickTime.
- **Rich replies instead of ASCII.**
  - Diagrams: the agent writes ```` ```mermaid ```` or ```` ```svg ```` blocks, and they render as real diagrams.
  - Media: it can embed project images, video and audio with Markdown image syntax, and they show up as inline players.
  - So "show me the frames for shot 1.3" is answered with the actual frames.
- **Clickable file references.** Any inline-code path relative to the project opens in a tab. Paths that don't exist are struck through, so a hallucinated path is visible at once. The system prompt is extended so the agent writes paths in this form.
- File access is scoped to the project directory (path traversal returns 403).

## SDK friction (actionable)

1. **`listSessions()` returns no `cwd` for large transcripts.** This happened for 4 of my 28 sessions, the large ones (100MB+). My picker first grouped them under the current project. Resuming one would have started the agent **in the wrong directory**. As a workaround I read `cwd` from the first 256KB of the `.jsonl` file. A reliable `cwd`, or a `listSessions({ includeCwd: true })`, would help.
2. **No supported API for plan limits.** I read the 5h and weekly utilization from `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, with `rate_limit_event` as a fallback. The utilization scale is inconsistent between the two (0–1 vs 0–100). A stable `getUsage()` would make limit meters easy to build for any SDK frontend.
3. **Switching cwd or session needs a process restart.** `query()` is bound to one cwd and session. A supported way to swap the session in a live process, or a documented pattern for it, would remove the exit-and-relaunch supervisor.
4. **Slash commands are plain user messages** (`/compact`, `/clear`). This works, but typed commands, for example `q.compact()` / `q.clear()` with a result event, would be clearer. `conversation_reset` and `compact_boundary` were enough to keep the UI in sync, and they're great.
5. **What worked very well:** streaming input with `priority: 'next' | 'now'`, `interrupt()`, `getContextUsage()`, `getSessionMessages()`, and permission callbacks. Building a full "Claude Code in a browser" took a day.

## Suggestion

Inline-comment review over the whole conversation, plus first-class media and diagram rendering, would be a strong addition to the official Claude Code web and desktop apps. A shared sample of this kind of frontend in the SDK docs would also help.
