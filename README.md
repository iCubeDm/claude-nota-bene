<p align="center"><img src="web/public/icon-512.png" width="128" alt="Nota Bene"></p>

# Nota Bene

A browser IDE for [Claude Code](https://claude.com/claude-code), built on the Claude Agent SDK. Same agent, same settings, skills and plugins, with a review-first interface: select any fragment of a reply or a file, leave a margin note, send all notes to the agent as one batch. Mermaid/SVG, images, video and audio render in the chat; a file tree and viewer cover the project.

## Requirements

- Node >= 23.6 (the server runs `.ts` directly)
- Claude Code, logged in

```sh
npm install
```

## Install the `/nb` skill

```sh
ln -s "$PWD/skill" ~/.claude/skills/nb
```

## Usage

In any project, inside Claude Code:

- `/nb` - open the window for this folder, resuming its last session (or start one)
- `/nb new` - start a fresh session
- `/nb fork` - carry this conversation over as a separate branch

Without the skill:

```sh
node bin/nota-bene.mjs [dir] [--port N] [--resume ID [--fork]] [--new] [--detach]
npm start [-- <dir> --port N]     # builds web/dist, serves on 4777
```

One window per folder; live windows use ports 4777-4799. The launcher relaunches the server on restart and crashes.

## Dev mode

```sh
npm run dev      # server :4780 + Vite :5173, state in ~/.nota-bene-dev
```

## Tests

```sh
npm test         # unit (vitest)
npm run e2e      # Playwright, ports 4791-4795
```

## State

`~/.nota-bene/` (override with `NOTA_BENE_HOME`), never in the repo: `sessions.json`, `prefs.json`, `comments/`, `attachments/`, `windows/`, `locks/`.

`prototype/` is the retired first version, kept as an archive and reference.
