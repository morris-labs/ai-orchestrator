#!/usr/bin/env bash
# The shared-container keeper: PID 1 of every project container.
#
# Usage: keeper.sh STATE GRACE
#
#   STATE  The state directory shared with the host, /run/claude-box.
#   GRACE  Seconds the container stays up with no tmux sessions and no
#          active review runs.
#
# Each second the keeper writes the live tmux session names to
# $STATE/sessions, keeps agentbox-engine running as a background child
# (restarting it when it exits), and exits once GRACE seconds pass with no
# sessions and no active runs. The engine writes its active-run count to
# $STATE/active-runs each second; a missing file, or one older than
# AGENTBOX_ACTIVE_RUNS_STALE seconds (default 6), counts as zero.
#
# Environment:
#   AGENTBOX_ENGINE_CMD            The engine program. Default: agentbox-engine.
#   AGENTBOX_ENGINE_RESTART_DELAY  Minimum seconds between engine starts. Default: 5.
#   AGENTBOX_ACTIVE_RUNS_STALE     Age in seconds after which active-runs counts as zero.
#   AGENTBOX_ENGINE_STOP_TIMEOUT   Seconds to wait for the engine after SIGTERM. Default: 10.

STATE="${1-}"; GRACE="${2-}"; IDLE=$SECONDS

ENGINE_CMD=${AGENTBOX_ENGINE_CMD:-agentbox-engine}
ENGINE_RESTART_DELAY=${AGENTBOX_ENGINE_RESTART_DELAY:-5}
ACTIVE_RUNS_STALE=${AGENTBOX_ACTIVE_RUNS_STALE:-6}
ENGINE_STOP_TIMEOUT=${AGENTBOX_ENGINE_STOP_TIMEOUT:-10}
ENGINE_PID=
ENGINE_STARTED_AT=
ENGINE_MISSING_REPORTED=
export AGENTBOX_STATE_DIR="$STATE"

log() {
  printf 'keeper: %s\n' "$*" >&2
}

# A bad GRACE would keep the container up forever with an error each second,
# and an empty STATE would write to /sessions, so both are checked first.
case $GRACE in
  '' | *[!0-9]*) log "GRACE must be a whole number of seconds, got '$GRACE'"; exit 2 ;;
esac
if [ ! -d "$STATE" ]; then
  log "STATE must be an existing directory, got '$STATE'"
  exit 2
fi

# Starts the engine unless it runs, waiting ENGINE_RESTART_DELAY seconds
# between starts so a crashing engine can't spin.
ensure_engine() {
  if [ -n "$ENGINE_PID" ]; then
    if kill -0 "$ENGINE_PID" 2>/dev/null; then
      return
    fi
    wait "$ENGINE_PID" 2>/dev/null
    log "$ENGINE_CMD exited with status $?; restarting it"
    ENGINE_PID=
  fi
  if ! command -v "$ENGINE_CMD" >/dev/null 2>&1; then
    if [ -z "$ENGINE_MISSING_REPORTED" ]; then
      log "$ENGINE_CMD isn't installed; running without the engine"
      ENGINE_MISSING_REPORTED=1
    fi
    return
  fi
  if [ -n "$ENGINE_STARTED_AT" ] && [ $((SECONDS - ENGINE_STARTED_AT)) -lt "$ENGINE_RESTART_DELAY" ]; then
    return
  fi
  "$ENGINE_CMD" &
  ENGINE_PID=$!
  ENGINE_STARTED_AT=$SECONDS
}

# Sends SIGTERM to the engine and waits for it, then SIGKILL after the timeout.
stop_engine() {
  [ -n "$ENGINE_PID" ] || return
  if kill -TERM "$ENGINE_PID" 2>/dev/null; then
    local waited=0
    while kill -0 "$ENGINE_PID" 2>/dev/null && [ "$waited" -lt "$ENGINE_STOP_TIMEOUT" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    kill -KILL "$ENGINE_PID" 2>/dev/null
  fi
  wait "$ENGINE_PID" 2>/dev/null
  ENGINE_PID=
}

# Prints the engine's active-run count, or 0 when the file is missing,
# stale, or unreadable.
active_runs() {
  local file="$STATE/active-runs" mtime now count=0
  if [ -f "$file" ] && mtime=$(stat -c %Y "$file" 2>/dev/null); then
    printf -v now '%(%s)T' -1
    if [ $((now - mtime)) -le "$ACTIVE_RUNS_STALE" ]; then
      read -r count < "$file" || count=0
    fi
  fi
  case $count in
    '' | *[!0-9]*) count=0 ;;
  esac
  printf '%s\n' "$count"
}

trap 'stop_engine; exit 0' TERM INT

while :; do
  tmux list-sessions -F '#S' > "$STATE/sessions.tmp" 2>/dev/null
  mv -f "$STATE/sessions.tmp" "$STATE/sessions"
  ensure_engine
  if [ -s "$STATE/sessions" ] || [ "$(active_runs)" -gt 0 ]; then IDLE=$SECONDS
  elif [ $((SECONDS-IDLE)) -gt "$GRACE" ]; then break; fi
  sleep 1
done

stop_engine
