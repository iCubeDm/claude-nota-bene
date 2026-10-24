#!/bin/bash
# Open Nota Bene (browser chat over Claude Code with inline comments) on the current folder. Called by the /nb skill.
# Usage: open.sh "<skill arguments>" <calling sessionId>
#   no arguments — resume the last window session of this folder (from .sessions.json), else a new one;
#                  a window already open on the folder is just brought to front
#   new          — always a new session
#   fork         — carry the calling terminal conversation over: the window resumes it as a fork (new
#                  session id), so the terminal and the window never append to one transcript
APP="$(cd -P "$(dirname "$0")/.." && pwd)"   # skill dir is symlinked from ~/.claude/skills
DIR="$(pwd -P)"
ARG="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)" SID="${2:-}"
case "$ARG" in
  "") MODE=last ;;
  new|новая|новую|заново) MODE=new ;;
  fork|continue|here|продолжить|продолжи|форк) MODE=fork ;;
  *) echo "NB: unknown argument '$1'. Use /nb (resume the last window session here), /nb new, or /nb fork (carry this conversation over)."; exit 0 ;;
esac

if [ -n "${AI_IDE_SUPERVISED:-}" ]; then
  echo "NB: already running inside Nota Bene — nothing to open."; exit 0
fi
case "$DIR" in "$HOME"|/) echo "NB: refusing to open the whole $DIR as a project — cd into a project first."; exit 0;; esac

info() { curl -s --max-time 0.5 "http://127.0.0.1:$1/info"; }

# a window already serving this folder → just bring it to front
for p in $(seq 4777 4799); do
  root="$(info "$p" | sed -n 's/.*"root":"\([^"]*\)".*/\1/p')"
  if [ "$root" = "$DIR" ]; then
    open "http://127.0.0.1:$p"
    if [ "$MODE" = fork ]; then
      echo "NB: a window is already open on this folder at http://127.0.0.1:$p (brought to front). It was NOT switched to this conversation: switching restarts it and may cut a running turn. To move this conversation there, quit the terminal claude and pick it in Sessions ▾."
    else
      echo "NB: already open at http://127.0.0.1:$p (brought to front)."
    fi
    exit 0
  fi
done

PORT=""
for p in $(seq 4777 4799); do
  if ! nc -z 127.0.0.1 "$p" 2>/dev/null; then PORT=$p; break; fi
done
[ -z "$PORT" ] && { echo "NB: no free port in 4777–4799."; exit 1; }

EXTRA=() NOTE=""
if [ "$MODE" = last ]; then
  # the server records the session of each project dir in .sessions.json (realpath keys, same as $DIR)
  LAST="$(node -e 'try { const s = require(process.argv[1])[process.argv[2]]; if (s) console.log(s) } catch {}' "$APP/.sessions.json" "$DIR")"
  # only if its transcript still exists: a deleted session would make the SDK fail on resume
  if [[ "$LAST" =~ ^[0-9a-fA-F-]{36}$ ]] && ls "$HOME"/.claude/projects/*/"$LAST.jsonl" >/dev/null 2>&1; then
    EXTRA=(--resume "$LAST") NOTE=" (resumed the last window session ${LAST:0:8})"
  else
    NOTE=" (new session: no earlier window session for this folder)"
  fi
elif [ "$MODE" = fork ]; then
  [[ "$SID" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "NB: no valid session id to fork ('$SID')."; exit 1; }
  EXTRA=(--resume "$SID" --fork) NOTE=" (forked from this conversation)"
fi

LOG="${TMPDIR:-/tmp}/nota-bene-$PORT.log"
nohup "$APP/ide.sh" "$DIR" --port "$PORT" "${EXTRA[@]}" >"$LOG" 2>&1 </dev/null &
disown

for _ in $(seq 1 40); do
  if info "$PORT" >/dev/null && [ -n "$(info "$PORT")" ]; then
    echo "NB: opened http://127.0.0.1:$PORT for $DIR$NOTE. Log: $LOG"
    exit 0
  fi
  sleep 0.5
done
echo "NB: server did not come up in 20s. Last log lines:"; tail -n 15 "$LOG"; exit 1
