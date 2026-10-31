<p align="center"><img src="https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/web/public/icon-512.png" width="128" alt="Nota Bene"></p>

# Nota Bene

A browser IDE over [Claude Code](https://claude.com/claude-code), built on the Claude Agent SDK. It is the same agent with your settings, skills and plugins, in a window made for reviewing: select any fragment of a reply or of a file, leave a note in the margin, and send all the notes to the agent as one batch. The window also has a file tree, viewers for code, images, video and audio, and a session picker.

![Selecting text in a reply, adding a comment and sending it](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-text.gif)

## Install

You need Node.js 22 or newer, and Claude Code installed and logged in. The first run downloads about 330 MB, most of it the Agent SDK's binaries.

As a Claude Code plugin (recommended). In Claude Code:

```
/plugin marketplace add iCubeDm/nota-bene-ide
/plugin install nota-bene@nota-bene
```

Then, in any project folder:

```
/nb
```

The first `/nb` installs the `nota-bene-ide` npm package into the plugin's data folder and opens the window in your browser. The plugin's skill is `/nota-bene:nb`; the bare `/nb` works as long as no other skill has that name.

Or from a terminal, with no plugin:

```sh
cd your-project
npx nota-bene-ide

# or install the command once
npm i -g nota-bene-ide
nota-bene
```

## Supported

| | Status |
|---|---|
| Agent | Claude Code |
| macOS | tested |
| Linux | not tested |
| Windows | not supported (the `/nb` skill is a bash script) |

## Quick start

1. Run `/nb` (or `nota-bene`) in a project folder. The window opens already logged in.
2. Ask the agent something. When the reply arrives, select a sentence in it and press **Comment**. Type the note and press Cmd/Ctrl+Enter to add it.
3. Open a file from the **Files** panel, select a line of code, and comment on that too. Comments from every reply and file collect in the **Comments** panel.
4. Press **Send (2)**. The agent receives one message that lists each fragment with your note on it.

The same works on code:

![Commenting on a line of code](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-code.gif)

on images, where you draw on the picture and the marked picture goes to the agent:

![Marking up an image](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-image.gif)

and on single frames of a video:

![Marking up a video frame](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/annotate-video.gif)

## Features

- Chat with the Claude Code agent. A message sent while the agent works is injected into the running turn; Cmd/Ctrl+Enter interrupts the agent and sends.
- Margin comments on any reply, on your own messages and on any open file, sent as one batch. Eleven one-click labels (Looks good, Clarify this, Verify this, and others).
- Markup on images and video frames with a rectangle, ellipse, pen or arrow, and a comment on the marked frame.
- File tree and viewers: Markdown, highlighted code, images, video and audio with seeking. Mermaid and SVG diagrams render in the chat.
- Read-only views of other git worktrees and branches next to your own checkout.
- `@` mentions a file, `/` opens the agent's commands and skills, `!` runs a shell command in the project folder.
- Subagent conversations in their own tabs, and a drawer for background tasks.
- Sessions from any folder, branches of a conversation, the history from before each compaction.
- Agent permission modes, model and effort, context and plan-limit meters.
- Interface in English and Russian.

![The window: chat, file tree and comments panel](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/overview.png)

![The slash menu](https://raw.githubusercontent.com/iCubeDm/nota-bene-ide/main/docs/media/slash-menu.png)

## Guide

Starting options, every feature with an example, the security model, where state is kept and troubleshooting: [the guide](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/guide.md). How it is built: [architecture](https://github.com/iCubeDm/nota-bene-ide/blob/main/docs/architecture.md).

## Licence

Apache-2.0. See [LICENSE](https://github.com/iCubeDm/nota-bene-ide/blob/main/LICENSE) and [THIRD-PARTY-NOTICES.md](https://github.com/iCubeDm/nota-bene-ide/blob/main/THIRD-PARTY-NOTICES.md).

### Codex / ChatGPT (feature branch)

Codex support uses the installed **Codex CLI 0.166.0 or newer** through its native
`app-server`. A ChatGPT account signed in with `codex login` is sufficient; Nota Bene
does not read authentication files or require a separate API key. Existing configured
API-key accounts also use the native runtime.

Open a provider-bound window with `nota-bene . --agent codex --detach`. The default
without `--agent` remains Claude. Each provider has independent windows and saved
settings; both may run in the same project. Models, skills and sessions in a Codex
window come from Codex. Do not continue the same conversation in another client
while the window owns it; fork when carrying a CLI/Desktop conversation over.

To expose the skill in Codex CLI and local Desktop, link this checkout's skill into
`~/.agents/skills/nb` (do not overwrite an existing skill):

```sh
mkdir -p ~/.agents/skills
ln -s "$PWD/codex/skills/nb" ~/.agents/skills/nb
```

For an npm install, copy `codex/skills/nb` from the installed `nota-bene-ide` package
into that skill directory; its helper finds `nota-bene` on PATH. Reload skills or
restart Codex, then invoke `$nb`, `$nb new`, or `$nb fork` (or select nb in the
Desktop skill picker). Desktop uses supervised detached lifetime: finishing a chat
turn does not stop the window. Use Stop in the window to shut it down. CLI can keep
an owned background process. `fork` needs the actual invoking host's thread id;
without it the helper fails clearly. An already open window is brought forward,
without applying a requested new/fork to its conversation.

See [Codex support and limitations](docs/guide.md#codex-support) for verified
behavior and remaining parity gates. The existing Claude adapter and nb skill are
unchanged. ACP remains a future backend behind the same AgentBackend interface.
