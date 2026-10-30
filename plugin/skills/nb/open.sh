#!/bin/bash
# Open Nota Bene (browser chat over Claude Code with inline comments) on the current folder. Called by the /nb skill.
# Usage: open.sh [--data DIR] [--plan] "<skill arguments>" <calling sessionId>
#        open.sh [--data DIR] --wait <dir> [note]
#        open.sh [--data DIR] --run <dir> [launcher args...]   (package install only: installs if needed, then runs the launcher)
#   --data DIR is the plugin's data dir (SKILL.md passes ${CLAUDE_PLUGIN_DATA}: it is NOT in the env of Bash commands).
#   Where the launcher lives, in this order:
#     1. a checkout: bin/nota-bene.mjs three levels above this skill dir (plugin/skills/nb -> repo root), as before;
#        found through the ~/.claude/skills/nb symlink too. Needs Node >= 23.6 (it runs the .ts sources).
#     2. the npm package nota-bene-ide@<plugin version> installed under DIR/<version>/ (one install per version, about 330 MB each, not pruned yet; npm install --prefix DIR/<version>, done on the first
#        run, by --run, i.e. in the background task, never in the --plan preprocessing). Needs Node >= 22.
#        The version is the plugin's (.claude-plugin/plugin.json); a plugin update therefore reinstalls.
#   no arguments — a window already open on the folder is just brought to front; otherwise a new window, where the
#                  server resumes the folder's last window session (if its transcript still exists), else starts one
#   new          — always a new session
#   fork         — carry the calling terminal conversation over: the window resumes it as a fork (new session id),
#                  so the terminal and the window never append to one transcript
# --plan (what the skill runs) launches nothing: after the same guards and the same "already open" check it prints
#   NB-RUN: <the foreground launcher command>     the skill runs it as a Claude Code background task (its output is
#                                                 the window's log; stopping the task, or ending the session, ends it)
#   NB-WAIT: <open.sh --wait command>              then waits with it for the window to come up
#   NB-NAME: Nota Bene · <folder>                  the task's description
# or one NB: line (an error, a refusal, "already open"). Both commands are built by q(): a word of safe characters stays as it
# is, anything else (spaces, quotes, $, parentheses, non-ASCII) is single-quoted, so bash and zsh read each back exactly and
# Claude Code accepts the text (it refuses backslash-escaped spaces and $'\320...' escapes).
# --wait polls --find every 0.5 s for up to 40 s (NB_WAIT_SECS, test only) and prints "NB: opened URL for DIR<note>."
# Without --plan the window is started with --detach (terminal use).
# The launcher is bin/nota-bene.mjs (--find / --last / --detach). It keeps one window per folder (its launch lock),
# so two /nb at once end with one window; this script finds, words and relays. Runs on bash 3.2 (macOS).
SKDIR="$(cd -P "$(dirname "$0")" && pwd)"   # physical: the skill dir may be symlinked from ~/.claude/skills/nb
# this script as it was called (through the ~/.claude/skills/nb link), so NB-WAIT matches the skill's allowed-tools
SELF="$(cd "$(dirname "$0")" && pwd)/${0##*/}"
DIR="$(pwd -P)"

DATA=""
if [ "${1:-}" = --data ] && [ $# -ge 2 ]; then DATA="$2"; shift 2; fi
case "$DATA" in *'${'*) DATA="" ;; esac   # an unsubstituted ${CLAUDE_PLUGIN_DATA} is no directory
# --plan runs in the skill's `!` preprocessing: a non-zero exit there fails the whole skill with no model turn, so an error
# or refusal is printed and exits 0 (the model relays the NB: line). Every other mode keeps exit 1 for failures.
PLAN=""
[ "${1:-}" = --plan ] && PLAN=1
bail() { echo "$1"; if [ -n "$PLAN" ]; then exit 0; fi; exit 1; }

PKG=nota-bene-ide
SRC="" BIN="" VER="" MIN_MAJOR=23 MIN_MINOR=6 FIRST_RUN=""
if [ -f "$SKDIR/../../../bin/nota-bene.mjs" ]; then
  SRC=checkout
  BIN="$(cd -P "$SKDIR/../../.." && pwd)/bin/nota-bene.mjs"
elif [ -n "$DATA" ]; then
  SRC=package MIN_MAJOR=22 MIN_MINOR=0
  VER="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SKDIR/../../.claude-plugin/plugin.json" 2>/dev/null)"
  VER="${VER%%$'\n'*}"
  [[ "$VER" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || bail "NB: cannot read the plugin version (.claude-plugin/plugin.json beside skills/): reinstall the plugin."
  # one install per version: DATA/<version>/ (about 330 MB each). A plugin update installs beside the old one, so a session
  # still on the old version (or a window running from it) is never touched. Old version dirs are not pruned yet.
  PREFIX="$DATA/$VER"
  BIN="$PREFIX/node_modules/$PKG/bin/nota-bene.mjs"
  # installed = the marker (written last, after a good install) and the launcher
  if [ -f "$PREFIX/.nb-installed" ] && [ -f "$BIN" ]; then :; else FIRST_RUN=1; fi
else
  bail "NB: cannot find the Nota Bene launcher: no checkout above this skill and no plugin data dir. Install the plugin (/plugin marketplace add iCubeDm/nota-bene-ide, then /plugin install nota-bene@nota-bene) or link the skill from a checkout."
fi

# the checkout launcher imports the server's .ts files directly: Node >= 23.6 strips their types; the package is compiled
NODE="$(command -v node)"
NODE_V=""
[ -n "$NODE" ] && NODE_V="$(node -p process.versions.node 2>/dev/null)"
if ! [[ "$NODE_V" =~ ^([0-9]+)\.([0-9]+) ]] || [ "${BASH_REMATCH[1]}" -lt "$MIN_MAJOR" ] \
   || { [ "${BASH_REMATCH[1]}" -eq "$MIN_MAJOR" ] && [ "${BASH_REMATCH[2]}" -lt "$MIN_MINOR" ]; }; then
  if [ -n "$NODE" ]; then WHERE="at $NODE"; else WHERE="on PATH"; fi
  FLOOR="$MIN_MAJOR"; [ "$MIN_MINOR" -gt 0 ] && FLOOR="$MIN_MAJOR.$MIN_MINOR"
  bail "NB: Nota Bene needs Node >= $FLOOR; found ${NODE_V:-none} $WHERE. Make it the default node for Claude Code's shell (e.g. nvm alias default)."
fi

# npm is only needed for the first install of the package
NPM_MISSING="NB: npm not found on PATH; the first run installs $PKG@$VER with it. Install Node.js with npm (nodejs.org), or run \`npm install -g $PKG\` and open it with \`nota-bene\`."
# install the package into DATA/<version>; progress goes to our stdout (the background task's output). The lock keeps two /nb
# runs from installing at once. EVERY failure writes .nb-install-failed, which is how --wait learns of it.
STALE_SECS="${NB_LOCK_STALE_SECS:-3600}"   # a live slow install must not be robbed; a recycled pid costs one waiter timeout
lock_age() { # seconds since the lock was taken; huge when it carries no timestamp and is over a minute old; 0 when just taken
  local ts; ts="$(cat "$1/ts" 2>/dev/null)"
  if [[ "$ts" =~ ^[0-9]+$ ]]; then echo $(( $(date +%s) - ts )); return; fi
  if [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then echo 999999; else echo 0; fi
}
install_pkg() {
  local lock="$PREFIX/.nb-install.lock" failed="$PREFIX/.nb-install-failed" waited=0 log="$PREFIX/.nb-install.log" rc
  mkdir -p "$PREFIX" 2>/dev/null || { echo "NB: cannot create the plugin data dir $PREFIX."; return 1; }
  ifail() { { echo "$1"; [ -n "${2:-}" ] && tail -n 5 "$2" 2>/dev/null; } | tee "$failed"; rm -rf "$lock" 2>/dev/null; return 1; }
  command -v npm >/dev/null || { echo "$NPM_MISSING" | tee "$failed"; return 1; }
  while true; do
    # taking the lock = mkdir, then creating the pid file exclusively (noclobber) and finding our own pid in it. A lock another
    # waiter moved aside, put back or re-created under us fails the write or shows another pid: then it is not ours
    if mkdir "$lock" 2>/dev/null; then
      if { set -o noclobber; echo $$ > "$lock/pid"; } 2>/dev/null && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ]; then set +o noclobber; break; fi
      set +o noclobber
      sleep 0.2; continue
    fi
    local holder age; holder="$(cat "$lock/pid" 2>/dev/null)"; age="$(lock_age "$lock")"
    # reclaim a lock whose holder is gone (dead pid) or that is simply old (a recycled pid, or no timestamp at all); the rename
    # is atomic, so of several waiters one wins, and a lock that turns out fresh is put back
    if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null && [ "$age" -gt 3 ]; } || [ "$age" -gt "$STALE_SECS" ]; then
      if mv "$lock" "$lock.old.$$" 2>/dev/null; then
        if [ "$(lock_age "$lock.old.$$")" -le 3 ]; then mv "$lock.old.$$" "$lock" 2>/dev/null || rm -rf "$lock.old.$$"; else rm -rf "$lock.old.$$"; fi
      fi
      continue
    fi
    # another run is installing: wait for it, then use its result
    sleep 1; waited=$((waited + 1))
    if [ -f "$PREFIX/.nb-installed" ] && [ -f "$BIN" ]; then return 0; fi
    [ "$waited" -ge "${NB_INSTALL_WAIT_SECS:-540}" ] && { echo "NB: another install of $PKG@$VER is still running after ${waited}s." | tee "$failed"; return 1; }
  done
  date +%s > "$lock/ts"
  # taken: another run may have finished between our last look and the lock
  if [ -f "$PREFIX/.nb-installed" ] && [ -f "$BIN" ]; then rm -rf "$lock"; return 0; fi
  rm -f "$PREFIX/.nb-installed" "$failed"
  echo "Nota Bene: first run, installing $PKG@$VER into the plugin data dir (about 330 MB, this takes a while)..."
  npm install --prefix "$PREFIX" "$PKG@$VER" --no-audit --no-fund 2>&1 | tee "$log"; rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ] || [ ! -f "$BIN" ]; then
    ifail "NB: installing $PKG@$VER failed (npm exit $rc). Check the network and free disk space, then run /nb again; or run \`npm install --prefix \"$PREFIX\" $PKG@$VER\` yourself to see the full error." "$log"
    return 1
  fi
  echo "$VER" > "$PREFIX/.nb-installed"
  rm -rf "$lock"
  echo "Nota Bene: installed $PKG@$VER."
  return 0
}

# --run <dir> [launcher args]: the package launcher as the background task's foreground command, installing first if needed
if [ "${1:-}" = --run ]; then
  [ "$SRC" = package ] || { echo "NB: --run is for the package install only."; exit 1; }
  [ -n "$FIRST_RUN" ] && { install_pkg || exit 1; }
  shift
  exec node "$BIN" "$@"
fi

# --wait <dir> [note]: the window the background task is starting, once the registry has it (verified by /info)
if [ "${1:-}" = --wait ]; then
  WDIR="${2:-}" WNOTE="${3:-}" SECS="${NB_WAIT_SECS:-40}"
  [[ "$SECS" =~ ^[0-9]+$ ]] || SECS=40
  WDIR="$(cd -P "$WDIR" 2>/dev/null && pwd)" || { echo "NB: no such folder '${2:-}'."; exit 1; }
  if [ -n "$FIRST_RUN" ]; then
    # a first install is under way in the background task: wait for it (patiently), or for its failure marker
    ISECS="${NB_INSTALL_WAIT_SECS:-540}"; [[ "$ISECS" =~ ^[0-9]+$ ]] || ISECS=540
    GRACE="${NB_INSTALL_GRACE_SECS:-15}"; [[ "$GRACE" =~ ^[0-9]+$ ]] || GRACE=15
    for ((i = 0; i < ISECS * 2; i++)); do
      [ -f "$PREFIX/.nb-installed" ] && [ -f "$BIN" ] && break
      [ -f "$PREFIX/.nb-install-failed" ] && { cat "$PREFIX/.nb-install-failed"; exit 1; }
      # the background task died or was stopped without a word: its lock names a dead pid, or (after a moment for the task to
      # start) there is no lock and no marker at all. Say so now instead of waiting out the timeout.
      holder="$(cat "$PREFIX/.nb-install.lock/pid" 2>/dev/null)"
      if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } || { [ ! -d "$PREFIX/.nb-install.lock" ] && [ "$i" -ge $((GRACE * 2)) ]; }; then
        [ -f "$PREFIX/.nb-installed" ] && break
        echo "NB: the install of $PKG@$VER did not finish: the background task stopped or never started. Run /nb again."
        exit 1
      fi
      sleep 0.5
    done
    [ -f "$PREFIX/.nb-installed" ] || { echo "NB: the first install is still running after ${ISECS}s - see the background task's output."; exit 1; }
  fi
  for ((i = 0; i < SECS * 2; i++)); do
    PORT="$(node "$BIN" --find "$WDIR" 2>/dev/null)" && [ -n "$PORT" ] && {
      echo "NB: opened http://127.0.0.1:$PORT for $WDIR$WNOTE."; exit 0; }
    sleep 0.5
  done
  echo "NB: the window did not come up in ${SECS}s — see the background task's output."
  exit 1
fi
[ "${1:-}" = --plan ] && shift

ARG="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" SID="${2:-}"
case "$ARG" in
  "") MODE=last ;;
  new|новая|новую|заново) MODE=new ;;
  fork|continue|here|продолжить|продолжи|форк) MODE=fork ;;
  *) echo "NB: unknown argument '$1'. Use /nb (resume the last window session here), /nb new, or /nb fork (carry this conversation over)."; exit 0 ;;
esac

# inside a Nota Bene window (the launcher)
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
[ -z "$FIRST_RUN" ] && { PORT="$(node "$BIN" --find "$DIR" 2>/dev/null)" && [ -n "$PORT" ] && bring "$PORT"; }
# ... or any port of the range whose /info has this root: a lost registry write.
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
  if [ -n "$FIRST_RUN" ]; then
    NOTE=""   # nothing installed yet to ask
  elif LAST="$(node "$BIN" --last "$DIR" 2>/dev/null)" && [ -n "$LAST" ]; then
    NOTE=" (resumed the last window session ${LAST:0:8})"
  else
    NOTE=" (new session: no earlier window session for this folder)"
  fi
elif [ "$MODE" = new ]; then
  ARGS+=(--new)
else
  UUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  [[ "$SID" =~ $UUID ]] || bail "NB: no valid session id to fork ('$SID')."
  ARGS+=(--resume "$SID" --fork) NOTE=" (forked from this conversation)"
fi
# test only: the launcher tests run the real bin with the fake agent
[ -n "${NOTA_BENE_FAKE:-}" ] && ARGS+=(--fake "$NOTA_BENE_FAKE")

if [ -n "$PLAN" ]; then
  # One shell word that bash and zsh read back exactly, in the only forms Claude Code accepts when it matches allowed-tools: safe
  # characters as they are, anything else (spaces, parentheses, quotes, $, non-ASCII) in '...' with ' as '\'' (it refuses
  # backslash-escaped spaces and $'\320...' escapes). Control characters have no such form and keep printf %q's $'...'.
  # LC_ALL=C on sed too: the subshell's assignment is not exported, and sed in a UTF-8 locale drops invalid sequences.
  q() {
    (
      LC_ALL=C
      case "$1" in
        *[[:cntrl:]]*) printf '%q' "$1" ;;
        ""|*[!A-Za-z0-9_./:@%+=,-]*) printf "'%s'" "$(printf '%s' "$1" | LC_ALL=C sed "s/'/'\\\\''/g")" ;;
        *) printf '%s' "$1" ;;
      esac
    )
  }
  if [ -n "$FIRST_RUN" ]; then
    command -v npm >/dev/null || bail "$NPM_MISSING"
    rm -f "$PREFIX/.nb-install-failed" 2>/dev/null
    # the install runs inside the background task, never in this preprocessing
    RUN="$(q "$SELF") --data $(q "$DATA") --run $(q "$DIR")"
  else
    RUN="node $(q "$BIN") $(q "$DIR")"
  fi
  for a in "${ARGS[@]:1}"; do RUN+=" $(q "$a")"; done   # without the leading --detach: the task runs it in the foreground
  WAIT="$(q "$SELF")"
  [ "$SRC" = package ] && WAIT+=" --data $(q "$DATA")"
  WAIT+=" --wait $(q "$DIR")"
  [ -n "$NOTE" ] && WAIT+=" $(q "$NOTE")"
  echo "NB-RUN: $RUN"
  echo "NB-WAIT: $WAIT"
  NAME="${DIR##*/}"
  echo "NB-NAME: Nota Bene · ${NAME//$'\n'/ }"
  [ -n "$FIRST_RUN" ] && echo "NB-NOTE: first run: installing $PKG@$VER (about 330 MB) in the background task; this can take a few minutes."
  exit 0
fi
[ -n "$FIRST_RUN" ] && { install_pkg || exit 1; FIRST_RUN=""; }

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
