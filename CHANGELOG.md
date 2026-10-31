# Changelog

## 1.1.0 — 2026-10-31

- Add native Codex integration alongside Claude Code, using Codex CLI 0.166.0+
  and its existing ChatGPT or API-key login.
- Add a Codex CLI / local Desktop skill for opening, starting and forking sessions.
- Isolate windows, sessions, settings, secrets, comments and archives by provider.
- Support Codex streaming, paginated history, subagent tabs, native approvals,
  questions, model/reasoning controls, compaction and account-limit meters.
- Keep existing Claude behavior and its default launch path.
- Make unit tests independent of the invoking NB window's provider and launcher.
- Share repository instructions through AGENTS.md with a short Claude entry point.

Codex API limitations: force-background, terminal output-tail retrieval and prompt
suggestions are unavailable. Session cost is unknown for ChatGPT accounts. See the
guide for the supported workflows. ACP is not part of this release.

## 1.0.0

Initial npm release with the Claude Code backend, inline review comments, file and
media viewers, session history and the Claude Code plugin.
