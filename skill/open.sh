#!/bin/bash
# Open Nota Bene (browser chat over Claude Code with inline comments) on the current folder. Called by the /nb skill.
# Usage: open.sh "<skill arguments>" <calling sessionId>
#   no arguments — a window already open on the folder is just brought to front; otherwise a new window, where the
#                  server resumes the folder's last window session (if its transcript still exists), else starts one
#   new          — always a new session
#   fork         — carry the calling terminal conversation over: the window resumes it as a fork (new session id),
#                  so the terminal and the window never append to one transcript
# The launcher is bin/nota-bene.mjs (--find / --last / --detach). It keeps one window per folder (its launch lock),
# so two /nb at once end with one window; this script finds, words and relays. Runs on bash 3.2 (macOS).
APP="$(cd -P "$(dirname "$0")/.." && pwd)"   # the skill dir is symlinked from ~/.claude/skills/nb
BIN="$APP/bin/nota-bene.mjs"
DIR="$(pwd -P)"

# the launcher imports the server's .ts files directly: Node >= 23.6 strips their types
NODE="$(command -v node)"
NODE_V=""
[ -n "$NODE" ] && NODE_V="$(node -p process.versions.node 2>/dev/null)"
if ! [[ "$NODE_V" =~ ^([0-9]+)\.([0-9]+) ]] || [ "${BASH_REMATCH[1]}" -lt 23 ] \
   || { [ "${BASH_REMATCH[1]}" -eq 23 ] && [ "${BASH_REMATCH[2]}" -lt 6 ]; }; then
  if [ -n "$NODE" ]; then WHERE="at $NODE"; else WHERE="on PATH"; fi
  echo "NB: Nota Bene needs Node >= 23.6; found ${NODE_V:-none} $WHERE. Make it the default node for Claude Code's shell (e.g. nvm alias default)."
  exit 1
fi

ARG="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" SID="${2:-}"
case "$ARG" in
  "") MODE=last ;;
  new|новая|новую|заново) MODE=new ;;
  fork|continue|here|продолжить|продолжи|форк) MODE=fork ;;
  *) echo "NB: unknown argument '$1'. Use /nb (resume the last window session here), /nb new, or /nb fork (carry this conversation over)."; exit 0 ;;
esac

# inside a Nota Bene window (the rebuild's launcher, or the prototype's ide.sh)
if [ -n "${NOTA_BENE_SUPERVISED:-}" ] || [ -n "${AI_IDE_SUPERVISED:-}" ]; then
  echo "NB: already running inside Nota Bene — nothing to open."; exit 0
fi
HOME_P="$(cd -P "$HOME" 2>/dev/null && pwd)"
case "$DIR" in "$HOME"|"$HOME_P"|/) echo "NB: refusing to open the whole $DIR as a project — cd into a project first."; exit 0;; esac

# how a window comes to front (the bin uses the same: open on macOS, xdg-open elsewhere); without one, the user opens it
if [ "$(uname)" = Darwin ]; then OPENER=open; else OPENER="$(command -v xdg-open)"; fi
if [ -n "$OPENER" ]; then FRONT="brought to front"; else FRONT="open it in your browser"; fi

already() { # $1 = URL of a window already serving this folder
  if [ "$MODE" = fork ]; then
    echo "NB: a window is already open on this folder at $1 ($FRONT). It was NOT switched to this conversation: switching restarts it and may cut a running turn. To move this conversation there, quit the terminal claude and pick it in Sessions ▾."
  else
    echo "NB: already open at $1 ($FRONT)."
  fi
  exit 0
}
bring() { # $1 = port of a window found here: bring it to front ourselves
  [ -n "$OPENER" ] && "$OPENER" "http://127.0.0.1:$1" >/dev/null 2>&1
  already "http://127.0.0.1:$1"
}

# a window already serving this folder: the registry (verified by /info, stale entries pruned) ...
PORT="$(node "$BIN" --find "$DIR" 2>/dev/null)" && [ -n "$PORT" ] && bring "$PORT"
# ... or any port of the range whose /info has this root: prototype windows, or a lost registry write.
# 4780 is the dev server (npm run dev), never a window. Without curl the bin's own re-check still finds them.
if command -v curl >/dev/null; then
  FROM=4777 TO=4799 SKIP=4780
  if [[ "${NOTA_BENE_PORT_RANGE:-}" =~ ^([0-9]+)-([0-9]+)$ ]]; then FROM=${BASH_REMATCH[1]} TO=${BASH_REMATCH[2]} SKIP=; fi
  for p in $(seq "$FROM" "$TO"); do
    [ "$p" = "$SKIP" ] && continue
    root="$(curl -s --max-time 0.5 "http://127.0.0.1:$p/info" | sed -n 's/.*"root":"\([^"]*\)".*/\1/p')"
    [ "$root" = "$DIR" ] && bring "$p"
  done
fi

ARGS=(--detach) NOTE=""
if [ "$MODE" = last ]; then
  # the server itself resumes the folder's last session; --last only tells us which note to print
  if LAST="$(node "$BIN" --last "$DIR" 2>/dev/null)" && [ -n "$LAST" ]; then
    NOTE=" (resumed the last window session ${LAST:0:8})"
  else
    NOTE=" (new session: no earlier window session for this folder)"
  fi
elif [ "$MODE" = new ]; then
  ARGS+=(--new)
else
  UUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  [[ "$SID" =~ $UUID ]] || { echo "NB: no valid session id to fork ('$SID')."; exit 1; }
  ARGS+=(--resume "$SID" --fork) NOTE=" (forked from this conversation)"
fi
# test only: the launcher tests run the real bin with the fake agent
[ -n "${NOTA_BENE_FAKE:-}" ] && ARGS+=(--fake "$NOTA_BENE_FAKE")

# --detach prints one line: "opened URL", or "already-open URL" (a launch on this folder got there first; the bin
# brought that window to front)
ERR="$(mktemp "${TMPDIR:-/tmp}/nb-open.XXXXXX")"
OUT="$(node "$BIN" "$DIR" "${ARGS[@]}" 2>"$ERR" </dev/null)"; RC=$?
LINE='^(opened|already-open) (http://127\.0\.0\.1:([0-9]+))$'
if [ $RC -eq 0 ] && [[ "$OUT" =~ $LINE ]]; then
  rm -f "$ERR"
  VERB="${BASH_REMATCH[1]}" URL="${BASH_REMATCH[2]}" PORT="${BASH_REMATCH[3]}"
  [ "$VERB" = already-open ] && already "$URL"
  T="${TMPDIR:-/tmp}"
  echo "NB: opened $URL for $DIR$NOTE. Log: ${T%/}/nota-bene-$PORT.log"
  exit 0
fi
# the launcher's error (its "nota-bene: " prefix becomes ours), then the log tail it printed
{ [ -s "$ERR" ] && cat "$ERR" || echo "nota-bene: the launcher failed (exit code $RC)${OUT:+: $OUT}"; } \
  | sed '1{s/^nota-bene: //;s/^/NB: /;}'
rm -f "$ERR"
exit 1
