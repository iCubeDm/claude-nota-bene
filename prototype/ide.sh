#!/bin/bash
# Launch ai-ide for a project and relaunch it (same session) when the ↻ button asks for a restart.
# Usage: ide.sh [projectDir] [--continue] [--port N]
# Exit 75 = restart / session switch. A crash (any other non-zero code except Ctrl-C) also relaunches with
# --continue, so the window reconnects by itself; 5 crashes within a minute = something is broken, give up.
DIR="$(cd "$(dirname "$0")" && pwd)"
export AI_IDE_SUPERVISED=1
node "$DIR/server.mjs" "$@"
code=$?
crashes=()
while true; do
  if [ $code -eq 75 ]; then :
  elif [ $code -eq 0 ] || [ $code -eq 130 ] || [ $code -eq 143 ]; then exit $code
  else
    now=$(date +%s); recent=()
    for t in "${crashes[@]}"; do [ $((now - t)) -lt 60 ] && recent+=("$t"); done
    crashes=("${recent[@]}" "$now")
    echo "ai-ide: server exited with code $code — relaunching (${#crashes[@]} crash(es) in the last minute)" >&2
    if [ ${#crashes[@]} -ge 5 ]; then echo "ai-ide: crashing in a loop, giving up" >&2; exit $code; fi
    sleep 1
  fi
  NO_OPEN=1 node "$DIR/server.mjs" "$@" --continue
  code=$?
done
