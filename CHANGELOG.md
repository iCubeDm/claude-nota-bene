# Changelog

## 1.1.1 — 2026-10-31

- Refuse a Codex CLI older than 0.166.0 with a clear message instead of a native
  RPC failure on the first unsupported call.
- The Codex plugin no longer downloads the Claude Code binary: first use is about
  70 MB instead of 330 MB.
- A Claude window started from an install without the Claude Code binary stops with
  one clear message instead of crashing five times.
- Fix a race in the Claude plugin's first install: several simultaneous `/nb` runs
  facing a stale lock could install twice or wait a minute.
- Name the right agent in the login and About texts of a Codex window.
- Add continuous integration on macOS and Linux, a check that every release pin
  follows the package version, and a Codex screenshot in the README.

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

The repository also provides a Codex marketplace plugin for this runtime. Install
it with `codex plugin marketplace add iCubeDm/nota-bene-ide --ref main` and
`codex plugin add nota-bene@nota-bene`; its first `$nb` fetches the pinned 1.1.0
npm package. The marketplace files are distributed from GitHub separately from
the immutable npm archive.

## 1.0.0

Initial npm release with the Claude Code backend, inline review comments, file and
media viewers, session history and the Claude Code plugin.
