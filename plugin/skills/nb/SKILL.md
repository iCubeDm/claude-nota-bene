---
name: nb
description: Open Nota Bene — the browser window over Claude Code with inline margin comments, file tree and media viewer — on the current folder. `/nb` resumes the window's last session for this folder (or starts one); `/nb new` starts fresh; `/nb fork` carries this conversation over.
argument-hint: "[new | fork]"
disable-model-invocation: true
allowed-tools: Bash(*/nb/open.sh* *), Bash(node */bin/nota-bene.mjs* *)
---

# Nota Bene

!`"${CLAUDE_SKILL_DIR}/open.sh" --data '${CLAUDE_PLUGIN_DATA}' --plan "$ARGUMENTS" "${CLAUDE_SESSION_ID}"`

## Your task

The output above comes from the launcher's planner. It is either one `NB:` line, or the lines `NB-RUN:`, `NB-WAIT:`, `NB-NAME:` and, on a first install only, `NB-NOTE:`.

- **`NB-RUN:` is there** — start the window as this session's background task:
  1. Run the `NB-RUN` command exactly as given (verbatim: do not re-quote or edit it) with the Bash tool and `run_in_background: true`, with the `NB-NAME` text as the description.
  2. If there is an `NB-NOTE:` line, tell the user its text in one short line now (the first run installs the package, which takes a few minutes). Then run the `NB-WAIT` command exactly as given, in the foreground (with the Bash tool's `timeout` set to 600000 when there was an `NB-NOTE:` line: the install can outlast the default). It prints one `NB:` line.
  3. If it says `NB: opened …`: reply with one short line containing the URL, in the user's language. The URL is plain: the browser is already open and logged in (the launcher opened it); never add or look for a token. If it says *resumed*, mention which session continues. If it says *forked*, add that the browser window continues this conversation as a separate branch, so further messages here and there no longer see each other. Add once that the window runs as this session's background task: it can be stopped in the task list, and it stops when this Claude Code session ends.
  4. If it reports an error: relay it in one or two lines. Do not retry.
- **Only an `NB:` line** — it brought an open window to front, or reports an error or a refusal: reply in one short line with the URL, or relay the error in one or two lines with the fix it names. Do not retry, and do not start the server yourself.

Do nothing else.
