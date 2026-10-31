---
name: nb
description: Open Nota Bene on the current project from Codex CLI or local Codex Desktop, with inline review comments, files and media. Use for nb, nb new, or nb fork.
---

# Nota Bene for Codex

Run `node <this-skill-directory>/open.mjs [new|fork] --host desktop|cli` in the user's project directory. Resolve this script relative to this SKILL.md; pass arguments as separate shell words, quoting paths with spaces.

For the marketplace plugin (a `plugin.json` exists two directories above this skill), run the helper through the pinned npm launcher instead:

```sh
npm exec --yes --package=nota-bene-ide@1.1.0 -- node "<this-skill-directory>/open.mjs" [new|fork] --host desktop|cli
```

Replace the placeholders; omit `[new|fork]` for a normal launch. Keep the same working directory and host lifetime rules below. This downloads the launcher on first use and reuses npm's cache afterward; tell the user the first launch may take a few minutes. No global installation or manual skill copying is required. npm makes `nota-bene` available to the helper on PATH. For a standalone copied skill without a plugin manifest, use the direct `node` command and an installed `nota-bene-ide` launcher.

- Local Codex Desktop: use `--host desktop`. It opens a supervised detached window that survives finishing this turn or closing this chat. Wait for the command to finish; return its plain URL. Explicit Stop in the window ends its server.
- Codex CLI: use `--host cli` in the host's supported background execution, keep the owned process running, and report the plain URL once ready. If background execution is unavailable, use Desktop lifetime and state that the window needs explicit Stop.
- No argument: resume the folder's last Nota Bene Codex session, or start one. `new`: start fresh. `fork`: branch the actual invoking conversation. The helper reads CODEX_THREAD_ID, or accepts `--source` with a thread id explicitly supplied by the host. If unavailable, stop and explain; never guess from transcript timestamps or another chat.
- An already open Codex window is brought forward. A requested new/fork is not applied to its conversation; relay the helper's explanation. Claude's window is independent.
- Use the existing Codex account login. If sign-in is missing, use `codex login` or the window's sign-in/retry control. Do not read credentials or request an API key for a ChatGPT account.

Relay launch errors and URLs honestly. Never print browser login tokens, call `nota-bene --url` into the conversation, close the window when the turn finishes, or change another client's conversation to make the launch succeed. Do not modify global skills or install global packages during invocation. If npm fails, relay its error; do not silently switch versions. For a standalone skill, a missing launcher means install `nota-bene-ide` first.
