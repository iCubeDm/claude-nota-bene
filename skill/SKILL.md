---
name: nb
description: Open Nota Bene — the browser window over Claude Code with inline margin comments, file tree and media viewer — on the current folder. `/nb` resumes the window's last session for this folder (or starts one); `/nb new` starts fresh; `/nb fork` carries this conversation over.
argument-hint: "[new | fork]"
disable-model-invocation: true
allowed-tools: Bash(*/nb/open.sh *)
---

# Nota Bene

!`"${CLAUDE_SKILL_DIR}/open.sh" "$ARGUMENTS" "${CLAUDE_SESSION_ID}"`

## Your task

The output above comes from the launcher and starts with `NB:`.

- It opened or brought up a window: reply with one short line containing the URL, in the user's language. If it says *resumed*, mention which session continues. If it says *forked*, add that the browser window continues this conversation as a separate branch, so further messages here and there no longer see each other. Do nothing else.
- It reports an error or a refusal: relay it in one or two lines and suggest the fix it names. Do not retry, and do not start the server yourself.
