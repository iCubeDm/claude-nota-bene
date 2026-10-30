# Nota Bene guide

Nota Bene is a browser window over Claude Code. This guide covers starting it, each feature with an example, the security model, where state is kept, and what to do when something goes wrong. For a short introduction see the [README](https://github.com/iCubeDm/nota-bene-ide/blob/main/README.md); for how it is built see [architecture](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/architecture.md).

Contents

- [Starting a window](#starting-a-window)
- [One window per folder, one tab per window](#one-window-per-folder-one-tab-per-window)
- [Chat](#chat)
- [Margin comments and the batch send](#margin-comments-and-the-batch-send)
- [The @ picker and the / menu](#the--picker-and-the--menu)
- [Shell commands with !](#shell-commands-with-)
- [Files, branches and worktrees](#files-branches-and-worktrees)
- [Images and video](#images-and-video)
- [Subagents and background tasks](#subagents-and-background-tasks)
- [Sessions and history](#sessions-and-history)
- [Permission modes, settings, languages](#permission-modes-settings-languages)
- [Hotkeys](#hotkeys)
- [Security](#security)
- [State on disk](#state-on-disk)
- [Troubleshooting](#troubleshooting)

## Starting a window

### From Claude Code: `/nb`

With the plugin installed (see the README), type in any Claude Code session:

| Command | What it does |
|---|---|
| `/nb` | Opens the window for the current folder and resumes the folder's last session, or starts one. |
| `/nb new` | Opens the window on a fresh session. |
| `/nb fork` | Continues the current Claude Code conversation in the browser as a separate branch. Messages sent here and there no longer see each other. |

The window runs as a background task of that Claude Code session. It shows in the task list, its output is the window's log, and it stops when you stop the task or end the session. The first `/nb` after installing or updating the plugin installs the npm package into the plugin's data folder (about 330 MB per plugin version) and takes a few minutes.

If a window for the folder is already open, `/nb` brings it to the front instead of starting another.

### From a terminal: `nota-bene`

```sh
nota-bene [dir] [options]
npx nota-bene-ide [dir] [options]
```

`dir` is the project folder and defaults to the current one. The launcher refuses your home folder and `/`: it asks you to `cd` into a project first.

| Option | Meaning |
|---|---|
| `--port N` | Listen on port N. Without it the launcher takes the first free port from 4777 to 4799, skipping 4780 and 4790 to 4795. |
| `--resume ID` | Open the session with this id instead of the folder's last one. |
| `--resume ID --fork` | Open that session as a new branch; the original stays as it is. `--fork` needs `--resume`. |
| `--new` | Start a fresh session. Cannot be combined with `--resume`. |
| `--detach` | Start the window on its own and return after printing one line, `opened URL` or `already-open URL`. The log is `$TMPDIR/nota-bene-PORT.log`. |
| `--no-open` | Do not open the browser. |
| `--url PORT` | Print the login URL of the window on PORT. Use it to log in a second browser. |
| `--front PORT` | Bring the window on PORT to the front in the browser, logged in. |

Without `--detach` the launcher stays in the foreground; Ctrl-C stops the server and closes the window. The first line it prints after any build is `Nota Bene: URL  project: DIR`.

Helpers that the `/nb` skill uses, handy in scripts: `nota-bene --find DIR [--scan]` prints the port of the live window serving DIR (exit 1 if there is none), `nota-bene --last DIR` prints DIR's last session id if its transcript still exists, `nota-bene --version`, `nota-bene --help`.

Example: open a project without a browser and get the login URL for a different one.

```sh
nota-bene ~/work/app --port 4800 --no-open
# in another terminal
nota-bene --url 4800
# http://127.0.0.1:4800/#t=...
```

The launcher supervises the server. When you pick "Restart the server" in the window, it relaunches the server at once and the session resumes. A crash is relaunched after one second; five crashes within a minute and it gives up.

## One window per folder, one tab per window

A folder has at most one window. Launching again on a folder that is already open (with `/nb` or `nota-bene`) does not start a second server: it brings the existing window to the front. If the window is in the middle of a restart, the launch waits up to 10 seconds for it.

A window also has one owner tab. Open the same address in a second browser tab and that tab shows "The window is already open in another tab". Press **Work here** to take the window over: the first tab then shows "Open in another tab" and stops. A reload of the owner tab within a moment is not counted as a second tab.

## Chat

The chat is the first tab and cannot be closed. Type a message and press Enter to send, Shift+Enter for a new line.

- A message sent while the agent is working is injected into the running turn.
- Cmd/Ctrl+Enter interrupts the agent and sends. Esc or the stop button stops the agent.
- Shift+Tab in the message field cycles the permission mode (see below).
- Tool calls appear as lines such as `Read` or `Bash` with their argument. Click one to see the full input and output; errors are red.
- A permission request shows as a card with **Allow** and **Deny**. In plan mode, the plan appears as a card: **Approve** continues in the previous mode, **Keep planning** stays in plan mode.
- Mermaid and SVG blocks in replies render as diagrams. The **Open diagram** button opens one full size in its own tab.
- The bar under the message box shows the context size, the 5-hour and weekly plan limits, and the session's API cost. The compact and clear buttons by the message box run `/compact` and `/clear`.
- An idle conversation is compacted for you 50 minutes after the last turn, if the window saw no activity for 15 minutes and the context is at least 200,000 tokens, so the prompt cache is not wasted. Click the idle-compaction indicator to turn it off for the project, or set `"idleCompaction": false` in `~/.claude/settings.json`.

## Margin comments and the batch send

This is the core of the tool: review first, then send everything at once.

**Example.** The agent replies with a plan and two paragraphs of code explanation.

1. Select the phrase "retry three times" in the reply. A **Comment** button appears next to the selection. Click it.
2. In the popup type `make this configurable` and press Cmd/Ctrl+Enter. The fragment turns yellow and a card appears in the **Comments** panel. Esc cancels the popup.
3. Select a line in a second reply, and instead of typing, click a quick label such as **Verify this**. One click adds the comment with no typing.
4. Open `src/queue.ts` from the **Files** panel, select a function and comment on it too.
5. The composer's button now reads **Send (3)**. Optionally type a message of your own. Press **Send**.

The agent receives one message that starts with "Comments on fragments:" and lists each fragment with its source (a chat reply, a file, a tool command) next to your note. Comments sent are shown dimmed and tagged "sent".

Details:

- You can comment on agent replies, on your own messages, on tool lines, on subagent replies (the comment goes to the main session), and on any open file.
- The quick labels are Looks good, Love it!, Clarify this, Verify this, Give me an example, Missing overview, Match existing patterns, Consider alternatives, Ensure no regression, Out of scope and Needs tests. Most carry a short instruction for the agent that is sent with the batch.
- Comment text takes emoji from the emoji menu or by typing a shortcode such as `:+1:`. The `@` picker works in the comment popup too.
- Click a highlighted fragment to open its card in a popup; edit or delete it there or in the panel. The panel's cards jump to the source. Tabs and tree rows show a count badge.
- Comments are stored per session and survive reloads and resumes. If the text a comment was made on has changed, the card is marked "fragment changed" and kept; for a file that changed since, "the file has changed since".
- The Comments panel opens with Cmd/Ctrl+Shift+C.
- `/clear` would drop pending comments, so the window refuses it until they are sent or removed.

## The @ picker and the / menu

### `@` picker

Type `@` at the start of a word in the message box (or in a comment popup) to search the project's files. Matching is fuzzy: `@qcfg` finds `src/queue/config.ts`. Arrow keys move, Enter or Tab inserts, Esc closes. Choosing a folder keeps the picker open inside it. A path with spaces is inserted in quotes. Paths in sent messages are clickable and open as tabs.

In a `!` shell command the same picker inserts the plain path, quoted as a shell word, rather than an `@` mention.

Alt+E opens a list of recent files with a project-wide file-name search.

### `/` menu

Type `/` as the first character of a message. A menu lists the agent's commands and skills, filtered as you type. Enter or Tab picks one; it writes `/name ` and leaves the caret after it. Esc closes the menu for that word.

What is in it:

- Every command and skill of the session that the Claude Code CLI itself marks as available outside a terminal: your own skills and commands, project and plugin ones, MCP prompts.
- A fixed set of built-in commands that were each tried against a real CLI without a terminal: `/compact`, `/clear`, `/context`, `/usage`, `/recap`, `/rename`, `/skill-doctor`, `/reload-skills`, `/list-agents`, `/dataviz`, `/claude-api`, `/simplify`, `/code-review`, `/verify`, `/run`, `/security-review`, `/loop`, `/update-config`, `/init`. They are labelled "built-in".

What is hidden: the commands the CLI tags as terminal-only, and built-ins that change the model, effort, output style or settings behind the interface's back (`/model`, `/effort`, `/output-style`, `/config` and similar) or that need a terminal (`/mcp`, `/doctor`, `/color`). A command you type by hand that is not in the menu still runs. The window's own controls cover the hidden ones: the model and effort pill in the header, the permission mode pill, Settings.

Output of local commands such as `/context` or `/usage` is shown as a reply.

`/compact` and `/clear` typed in the message box behave like the footer buttons, with two rules:

- While the agent is busy they are refused with "Not sent: wait for the agent to finish. /compact and /clear cannot be queued." Send them again when the turn ends.
- With pending comments, `/clear` is refused with "Not sent: /clear would drop the pending comments. Send or remove them first."

`/clear` starts a new conversation and keeps the old session in the Sessions list. `/compact` shows a progress line while it runs and a "context compacted" line when done.

## Shell commands with !

A draft whose first character is `!` and that is one line is a shell command, as in the Claude Code terminal. The box switches to a monospace font and shows "Shell · Enter runs"; the send button reads **Run**.

```
! git status
```

Press Enter. The command runs on the server in the project folder, and its output streams into a block in the chat.

The rules:

- Ordinary commands only. There is no terminal behind it and standard input is closed, so anything that waits for input (an editor such as vim, a pager, `git rebase -i`, `sudo`, a login or a password prompt) gets an empty input and ends by itself, usually with an error. Run those in a real terminal.
- It runs as `$SHELL -lc` (a login shell) when `$SHELL` is sh, bash, zsh, dash or ksh, and as `/bin/sh` otherwise. Nota Bene's own variables, and the ones Claude Code sets for its sessions, are not passed on.
- One at a time. A second one is refused with "Not run: a command is still running. Stop it or wait for it."
- It works while the agent is busy, because it does not go through the agent.
- Stop in the block ends it: the whole process group gets TERM, and KILL three seconds later if something is still there. A command that runs longer than 10 minutes is stopped the same way and marked "stopped: it ran longer than 10 minutes". Background jobs started by the command end with it.
- A command can be at most 32 KB. The block shows the last 64 KB of output with ANSI colour codes removed; the agent is given the last 32 KB of each of stdout and stderr.
- With pending comments or images in the draft it is not run: "Not run: the message has pending comments or images. Send or remove them first."
- To send a message that begins with `!` to the agent, put a space before it. A draft of several lines is always a message, never a command, and so is `![` (a Markdown image).

**How the agent hears about it.** Nothing is sent to the agent when the command finishes, and no extra turn is started. The finished run is queued, and in front of your next message the server puts the command and its output in the form Claude Code itself uses for `!` commands (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`). Up to 10 finished runs wait; together they are capped at 64 KB, newest kept, and a note says how many earlier runs were left out. A message that is itself a `/command` does not take the queued runs, so the command still works as one. A session switch or `/clear` drops the queue.

Example:

```
! npm test
```

The test output streams in, it fails, and you type `fix the failing test`. The agent receives the `npm test` command and its output followed by that sentence, in one message.

## Files, branches and worktrees

The **Files** panel (Cmd/Ctrl+Shift+F) is the project tree. It has a filter box, a refresh button that keeps open folders, collapse all and expand all, and a "select opened file" button; Alt+F1 reveals the current file in the tree. The tree refreshes after each turn of the agent.

Click a file to open it in a tab:

- Markdown renders and can be commented on. Code is highlighted and can be commented on. Alt+Z wraps long lines.
- Images, video and audio open in a viewer (next section).
- Files over 2 MB and binary files are not shown ("File is too large to show", "Binary file, not shown"). **Open raw** shows the file as the server sends it.
- Paths in `code` spans and relative links in the chat are clickable. A path whose file does not exist is struck through.

Tabs have a right-click menu: Close, Close others, Close to the right, Close all, and for files Copy path. A middle click closes a tab. Alt+W closes the active tab and Alt+Shift+T reopens the last closed one.

### Other branches and worktrees

The window never switches your checkout, since a live window may be running from it. Instead the **Source** selector above the tree lists "this folder", every other git worktree of the repository, and every local branch that has no worktree. Pick one and the tree shows its files. Files from another source open read-only in tabs marked with the branch name, and you can still comment on them; the comment remembers the ref.

Example: the agent works in the `feature/retry` worktree while your window is on `main`. Select that worktree in Source, open `src/queue.ts` from it, comment on a line, and send. Paths the agent prints inside another worktree open from that worktree too.

### 3D models (experimental)

Off by default. See [troubleshooting](#experimental-3d).

## Images and video

### Attaching images to a message

Paste an image from the clipboard, drop it on the window, or use the paperclip button. Images are scaled down to at most 1568 px on the long edge, and a PNG over 3.5 MB becomes a JPEG. They show as thumbnails in the draft and open in a lightbox. They are stored on the server by content hash and travel as ids, so a long history of screenshots does not slow a reload.

### Viewing and marking up images and video

Images open with a click to toggle natural size. Video and audio open with a player: play and pause (Space or K), seek, playback speed, volume, picture in picture, fullscreen. The seek step is set on the bar. A playing video goes to picture in picture when you leave its tab, and audio keeps playing; closing the tab stops it.

Player keys, when the player has focus:

| Key | Action |
|---|---|
| Space, K | play or pause |
| Left, Right | seek by the step set on the bar |
| J, L | back or forward 10 s |
| Up, Down | volume 5 % |
| M | mute |
| F | fullscreen (video) |
| 0 to 9 | jump to 0 to 90 % |
| comma, period | one frame back or forward while paused (video) |
| Home, End | to the start or end |
| N | annotate the frame |

**Example: marking up a video frame.** Pause the video where the button looks wrong and press **Mark up** (or N). Draw on the frame with Rectangle (R), Ellipse (E), Pen (P) or Arrow (A); pick a colour with 1 to 5 (red, yellow, green, blue, white); undo with Cmd/Ctrl+Z. Press **Comment** (Enter) and type `this button is misaligned`. Esc leaves markup mode, and asks before it throws away a drawing you have not commented on. The comment joins the batch. When you send, the agent receives the frame with your marks drawn on it and the note, along with the other comments. Several comments on one frame are combined into one image whose marks carry the comment numbers.

The marked frame and layer are saved in the project folder under `.nota-bene/marks/`, with a `.gitignore` inside that keeps them out of git (see [state on disk](#state-on-disk)).

### Images in the temp folder

When the agent leaves an image in a temporary folder, for example a screenshot saved to `/tmp/x.png`, the absolute path in inline code in the chat is a link, and a tool line that names one gets a button beside it. Click it and the image opens in a tab, like a project file: you can mark it up and comment on it. If the file is gone, the tab says so.

This is narrow on purpose. Only absolute paths inside the system temp folders (`/tmp`, `/private/tmp` and `os.tmpdir()`, checked after resolving symbolic links) are served, only image files (png, jpg, jpeg, gif, webp, avif, bmp, svg), up to 50 MB, one file at a time. There is no listing and no search of the temp folder, and nothing else outside the project is readable this way.

## Subagents and background tasks

When the agent starts a subagent, the call in the chat is a card with the subagent's type, a description and its status (running, done, error, stopped). **Open** shows the subagent's conversation in its own tab, read-only, refreshed while it runs. Comments you make there go to the main session. The message box always talks to the main agent, whichever tab is open.

The task indicator under the message box counts running subagents and background shell tasks. Click it or press Alt+T to open the **Tasks** drawer: a tree of subagents, shell tasks and monitors with status, elapsed time and the last tool. Per task you can open it, **Stop** it (click twice: the first click turns the button into "Stop?") or send a foreground call **To background**. A shell task opens as a **Task output** tab that shows the tail of its output and refreshes every second while it runs. Finished tasks stay in the list (the last 20).

## Sessions and history

**Sessions** in the header opens a picker over every Claude Code session on the machine, grouped by folder, with the current project first and a filter box (title or folder). Pick one to switch the window to it in place, without a reload. If the session is from another folder, the window moves to that project (tree, file access and the agent's working folder). The dialog warns you not to keep the same session open in a terminal `claude` at the same time: the history would get mixed up. **+ new session in this project** starts a fresh one. A new session can only start in the current folder or in a folder that already has sessions.

Branches of a conversation: `/nb fork` from Claude Code, or `nota-bene --resume ID --fork`, opens a copy of a conversation that continues on its own. The original is untouched.

Claude Code replays a session only from its last compaction. Nota Bene keeps what came before: after a `/compact` an earlier part of the chat shows a "Show before compaction" link that loads the archived segment. The archive is in `history/<sessionId>.jsonl` in the state folder.

The **↻ Agent** button restarts the agent and continues the same session. It stays available while the agent is busy, as an escape hatch for a stuck turn. The arrow next to it has **Restart the server**, shown when the window runs under the launcher (always for `/nb` and `nota-bene`, never for `npm start` or `npm run dev`). A **Restart server · code updated** button appears when the server's code changed after it started; this only matters when you are developing Nota Bene itself.

## Permission modes, settings, languages

### Agent permission modes

The mode pill under the message box, or Shift+Tab in the box, cycles through:

| Mode | Behaviour |
|---|---|
| Default | Asks before edits and commands. |
| Accept edits | Edits files without asking, asks before commands. |
| Plan | Only reads and thinks, changes nothing, and ends with a plan to approve. |
| Auto | A classifier approves safe actions itself and asks about the rest. |

The mode is saved per project folder. The model and effort pill in the header sets the model and the effort (Low, Medium, High, Extra high, Max); a change applies from the next reply, and the pill warns when it makes the next reply re-read the whole context.

### Settings

The gear in the header opens **Settings**:

- **Windows**: every running window with its folder, port, state (working or idle), number of open tabs and uptime. Open, Restart agent, Restart server and Stop work on any of them.
- **Storage**: what is on disk for pasted images, comments, chat history from before compaction and media marks, with **Clean unreferenced files**, which moves pasted images that no comment references and that are over a day old, and the history of sessions that no longer exist, to the state folder's `trash/`. Nothing is deleted.
- **Defaults**: interface language, and the agent mode for projects that have none of their own.
- **About**: version, state folder, where the logs are, Node version.

### Languages

The globe in the header lists the interface languages: English and Russian. The choice is saved in `prefs.json` and shared by all windows. English is the default whatever the browser language is.

## Hotkeys

The full list is in the window's Hotkeys help. Tab keys use Alt because Chrome keeps Cmd/Ctrl+W, T and 1 to 9. On a Mac, Option plus a letter types a character, so in a text field the Alt+letter shortcuts do not fire there.

| Keys | Action |
|---|---|
| Alt+W | close tab |
| Alt+Shift+T | reopen closed tab |
| Alt+Left, Alt+Right | previous or next tab |
| Alt+1 to Alt+9 | tab N (1 is the chat, 9 is the last) |
| Alt+E | recent files and project search |
| Cmd/Ctrl+Shift+F | Files panel |
| Cmd/Ctrl+Shift+C | Comments panel |
| Alt+T | Tasks drawer |
| Alt+Z | wrap lines in a text file |
| Alt+F1 | reveal the current file in the tree |
| / or Esc | focus the message box (outside text fields) |
| Shift+Tab (in the message box) | next permission mode |
| Enter, Shift+Enter | send, new line |
| Cmd/Ctrl+Enter | interrupt the agent and send |
| Esc (agent busy) | stop the agent |
| Cmd/Ctrl+Enter (comment popup) | add the comment |

## Security

Nota Bene gives a web page the power to read your project and run an agent, so it is built to let in only you.

- **Local only.** The server binds to `127.0.0.1`. Nothing outside your machine can connect. Hosts and origins are checked on top of that.
- **Access token.** The first launch creates `<state>/token` (state is `~/.nota-bene`, see below): 32 random bytes as hex, mode 600, in a folder with mode 700. Every route and the WebSocket need a credential derived from it. The token itself is never put on a command line, in an environment variable, in a URL or in a log, and the agent's environment and `!` commands do not get it.
- **How login works.** When the launcher opens your browser, it opens a small page in `<state>/open/` (mode 600) that redirects to `http://127.0.0.1:PORT/#t=LOGIN`. LOGIN is a keyed hash of the token, the port and a per-launch random value, not the token. The page removes it from the address bar, sends it to the server once, and the server answers with an HttpOnly, SameSite=Strict cookie `nb_<port>` that lasts a year and a key that the page keeps in its local storage. The cookie alone opens only `GET` of `/file` and `/attach/<id>` (what `<img>` and `<video>` need). Everything else, including the WebSocket, also needs the key.
- **A login belongs to one launch.** The login value, the cookie and the key all die when the launcher exits. After a crash relaunch they are replaced and the launcher opens a fresh login page. Restarting the server from the window keeps them, so open tabs stay logged in.
- **A second browser.** `nota-bene --url PORT` prints the login URL of a running window. Open it in the other browser. The URL works until that window's launcher exits. The command first checks that the port really answers as your window, and refuses with an error for a port that cannot prove it.
- **Rotating the token.** Delete `<state>/token` and restart the server. A window that was live under the old token can no longer be recognised by `nota-bene --find`, so reopen it; until you do, `/nb` or a new launch on that folder starts a second window.
- **The state folder is never served.** The file routes, the tree, search and branch views refuse anything inside the state folder, even when your project folder contains it.

The residual risk, in plain words:

- The token file is readable by any process running as your OS user, the agent included. The aim is to keep out other users and other software that cannot read your files, not your own tools.
- Browsers send cookies to every port on `127.0.0.1`. While a window is open, a local web server on another port that you visit in the same browser receives its `nb_<port>` cookie. With it, that server can read files of the open project through `/file` and pasted images through `/attach/<id>`. It cannot open the WebSocket, write anything or reach any other route, because those need the key, which only the page's own origin can read. The cookie stops working at the next launch.
- A token that was ever committed to git stays readable in the repository history after the file is removed. Do not make the state folder a repository.

## State on disk

All state lives in `~/.nota-bene/`, except the media marks. Set `NOTA_BENE_HOME` to use another folder. `npm run dev` of a source checkout uses `~/.nota-bene-dev`.

| Path | Holds |
|---|---|
| `token` | the access token; deleting it rotates it at the next server start |
| `control-token` | a separate secret for the controls between windows (Settings, Windows) |
| `open/` | the short-lived pages the browser is opened on |
| `sessions.json` | the last session of each project folder |
| `prefs.json` | agent mode per project, the interface language |
| `comments/<sessionId>.json` | pending and sent comments of a session |
| `attachments/<sha256>.<ext>` | pasted images, by content hash |
| `windows/<port>.json` | the registry of running windows |
| `locks/` | per-folder launch locks |
| `history/<sessionId>.jsonl` | the conversation before each compaction |
| `cache/blend/` | `.blend` files converted for the 3D tab (safe to delete) |
| `trash/` | what Settings, Storage, Clean moved |

The one exception is media marks: `<project>/.nota-bene/marks/<comment id>/frame.jpg` and `layer.png`, with a `.nota-bene/.gitignore` containing `*`. They are the only thing Nota Bene writes into a project folder.

## Troubleshooting

### An apostrophe in the plugin data path

`/nb` passes the plugin's data folder to its script in single quotes. If the path to it contains an apostrophe (a home folder such as `/Users/o'brien`), the quoting breaks and `/nb` fails before it starts. Use the terminal route instead: `npm i -g nota-bene-ide`, then `nota-bene` in the project folder.

### The sandbox message

If Claude Code's sandbox mode is on, the first `/nb` can end with "cannot write to the plugin data dir ... The likely cause is Claude Code's sandbox mode". The install needs to write outside the project. Allow writes to that folder in the sandbox settings, or turn the sandbox off for `/nb`. Retrying changes nothing until you do.

### Interactive commands

`sudo`, logins, password prompts, editors such as vim and pagers need a terminal. In `!` commands and in the agent's own shell they get an empty input. Run them in a real terminal.

### A refused token file

If `<state>/token` is readable by group or others, is a symbolic link, belongs to another user, or does not hold 64 hex characters, the launcher stops before starting a server and prints the file and the fix, for example ``fix it with `chmod 600 <file>`, or delete it to make a new token``. Nothing is replaced silently, because a new token logs every open window out. The same goes for `control-token` and for a state folder owned by another user (point `NOTA_BENE_HOME` at a folder of your own).

### "This window is not logged in"

The page you opened has no login: a bookmark, a copied address, or a tab left over from an earlier launch. Open the window again with `nota-bene` in the folder, or `/nb`: both bring the existing window to the front, logged in. From a terminal, `nota-bene --front PORT` does the same, and `nota-bene --url PORT` prints a URL. After a server crash and relaunch the old tab shows this message too, and the launcher opens a fresh page for you.

### `nota-bene . &` stops when the shell exits

A foreground launcher stops itself when the shell that started it is gone, so that no window is left running after its terminal closes. `nota-bene . &` in a script or a shell that exits ends the window with it. Use `nota-bene . --detach`, which starts the window on its own and prints its URL.

### The port is in use

With `--port N` the launcher stops with "port N is in use". Pick another port, or omit `--port`. Without it, the launcher takes the first free port from 4777 to 4799 and reports "no free port" if all are taken (close a window you do not need: Settings, Windows, Stop).

### Experimental 3D

The model tab for `.glb`, `.gltf` and `.blend` files is off by default. Turn it on by starting the server with the environment variable `NOTA_BENE_EXPERIMENTAL_3D=1`:

```sh
NOTA_BENE_EXPERIMENTAL_3D=1 nota-bene .
```

A `.blend` file needs Blender on the machine: the path in `NOTA_BENE_BLENDER`, else `blender` on `PATH`, else `/Applications/Blender.app/Contents/MacOS/Blender`. Blender converts the file in a locked-down mode (and under `sandbox-exec` on macOS), refuses a file that references files outside the project, takes one conversion at a time and gives up after 120 seconds. Models over 256 MB are not shown.

The variable is read when the server starts. If a window for the folder is already open, a new launch only brings that window to the front, and the variable is ignored: the open window keeps the setting it started with. Stop the window first, then launch again.
