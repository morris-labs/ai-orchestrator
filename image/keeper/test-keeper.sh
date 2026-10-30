#!/usr/bin/env bash
# Tests keeper.sh and start-session.sh with fake tmux and engine programs.
# Run from anywhere: image/keeper/test-keeper.sh. Needs bash and coreutils.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# Never let a test reach a real tmux server.
unset TMUX TMUX_PANE

FAILURES=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
# check NAME TEST...: passes NAME when the test command succeeds.
check() {
  local name=$1
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

mkdir -p "$WORK/bin"
# Fake tmux: list-sessions prints $FAKE_SESSIONS; has-session succeeds for
# names in it; new-session appends to it unless FAKE_DIE is set.
cat > "$WORK/bin/tmux" <<'FAKE'
#!/usr/bin/env bash
case $1 in
  list-sessions) [ -s "$FAKE_SESSIONS" ] && cat "$FAKE_SESSIONS" ;;
  has-session) grep -qx "${3#=}" "$FAKE_SESSIONS" 2>/dev/null ;;
  new-session)
    [ -n "${FAKE_FAIL:-}" ] && exit 1
    [ -z "${FAKE_DIE:-}" ] && printf '%s\n' "$4" >> "$FAKE_SESSIONS"
    printf '%s\n' "$*" >> "$FAKE_LOG" ;;
esac
FAKE
# Fake engine: records each start, exits on SIGTERM, or after
# $FAKE_ENGINE_LIFETIME seconds when set.
cat > "$WORK/bin/fake-engine" <<'FAKE'
#!/usr/bin/env bash
echo "start $AGENTBOX_STATE_DIR" >> "$FAKE_ENGINE_LOG"
trap 'echo term >> "$FAKE_ENGINE_LOG"; exit 0' TERM
end=$((SECONDS + ${FAKE_ENGINE_LIFETIME:-600}))
while [ "$SECONDS" -lt "$end" ]; do sleep 0.1; done
FAKE
chmod +x "$WORK/bin/tmux" "$WORK/bin/fake-engine"

export PATH="$WORK/bin:$PATH"
export AGENTBOX_ENGINE_CMD=fake-engine AGENTBOX_ENGINE_RESTART_DELAY=1 AGENTBOX_ENGINE_STOP_TIMEOUT=3

# Sets up a fresh case directory and exports the fakes' paths.
new_case() {
  CASE="$WORK/$1"
  mkdir -p "$CASE/state"
  export FAKE_SESSIONS="$CASE/sessions-list" FAKE_ENGINE_LOG="$CASE/engine.log" FAKE_LOG="$CASE/tmux.log"
  : > "$FAKE_ENGINE_LOG"
  rm -f "$FAKE_SESSIONS"
}

# Waits up to $2 seconds for pid $1 to exit; returns 1 on a timeout.
wait_exit() {
  local i
  for ((i = 0; i < $2 * 10; i++)); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

count() { grep -c "^$1" "$FAKE_ENGINE_LOG" 2>/dev/null || true; }

# 1. Idle: exits after the grace period and stops the engine.
new_case idle
"$HERE/keeper.sh" "$CASE/state" 1 &
pid=$!
if wait_exit "$pid" 6; then pass "an idle keeper exits after the grace period"; else fail "an idle keeper exits after the grace period"; kill "$pid"; fi
check "the keeper starts the engine" [ "$(count start)" -ge 1 ]
check "the keeper stops the engine on exit" [ "$(count term)" -ge 1 ]
check "the engine gets AGENTBOX_STATE_DIR" grep -q "start $CASE/state" "$FAKE_ENGINE_LOG"

# 2. Sessions keep it alive and land in the sessions file.
new_case sessions
printf 'claude-agent-a\nclaude-agent-b\n' > "$FAKE_SESSIONS"
"$HERE/keeper.sh" "$CASE/state" 1 &
pid=$!
sleep 3
if kill -0 "$pid" 2>/dev/null; then pass "live sessions keep the keeper up"; else fail "live sessions keep the keeper up"; fi
check "the keeper writes the session names" [ "$(cat "$CASE/state/sessions")" = $'claude-agent-a\nclaude-agent-b' ]
rm -f "$FAKE_SESSIONS"
if wait_exit "$pid" 6; then pass "the keeper exits once the sessions end"; else fail "the keeper exits once the sessions end"; kill "$pid"; fi
check "the sessions file is empty with no sessions" [ ! -s "$CASE/state/sessions" ]

# 3. A fresh active-runs count keeps it alive; a stale one doesn't.
new_case runs
"$HERE/keeper.sh" "$CASE/state" 1 &
pid=$!
(for _ in 1 2 3 4; do echo 2 > "$CASE/state/active-runs"; sleep 1; done) &
writer=$!
sleep 3.5
if kill -0 "$pid" 2>/dev/null; then pass "active runs keep the keeper up"; else fail "active runs keep the keeper up"; fi
wait "$writer"
touch -d '1 minute ago' "$CASE/state/active-runs"
if wait_exit "$pid" 6; then pass "a stale active-runs file counts as zero"; else fail "a stale active-runs file counts as zero"; kill "$pid"; fi

# 4. Garbage in active-runs counts as zero.
new_case garbage
echo "lots" > "$CASE/state/active-runs"
"$HERE/keeper.sh" "$CASE/state" 1 &
pid=$!
if wait_exit "$pid" 6; then pass "an unreadable count is zero"; else fail "an unreadable count is zero"; kill "$pid"; fi

# 5. A dying engine is restarted.
new_case restart
printf 'claude-agent-a\n' > "$FAKE_SESSIONS"
# A 2-second delay keeps restarts apart from the keeper's 1-second loop.
AGENTBOX_ENGINE_RESTART_DELAY=2 FAKE_ENGINE_LIFETIME=1 "$HERE/keeper.sh" "$CASE/state" 1 &
pid=$!
sleep 5
check "the keeper restarts an engine that exits" [ "$(count start)" -ge 2 ]
check "the keeper waits between engine restarts" [ "$(count start)" -le 4 ]
kill -TERM "$pid"
wait_exit "$pid" 6 || kill -KILL "$pid"

# 6. SIGTERM stops the engine and exits 0.
new_case term
printf 'claude-agent-a\n' > "$FAKE_SESSIONS"
"$HERE/keeper.sh" "$CASE/state" 30 &
pid=$!
sleep 1.5
kill -TERM "$pid"
wait "$pid"
status=$?
check "SIGTERM makes the keeper exit 0" [ "$status" -eq 0 ]
check "SIGTERM stops the engine" [ "$(count term)" -ge 1 ]

# 7. A missing engine program doesn't stop the keeper.
new_case missing
AGENTBOX_ENGINE_CMD=no-such-engine "$HERE/keeper.sh" "$CASE/state" 1 2> "$CASE/stderr" &
pid=$!
if wait_exit "$pid" 6; then pass "the keeper runs without an engine program"; else fail "the keeper runs without an engine program"; kill "$pid"; fi
check "a missing engine is reported once" [ "$(grep -c "isn't installed" "$CASE/stderr")" -eq 1 ]

# 8. start-session.sh: start, refuse a duplicate or a missing directory,
# and report an early exit.
new_case session
"$HERE/start-session.sh" claude-agent-x /tmp "claude --name x" 2>/dev/null
status=$?
check "start-session starts a session" [ "$status" -eq 0 ]
check "start-session passes the session, directory, and command" \
  grep -q -- "-s claude-agent-x -c /tmp -- claude --name x" "$FAKE_LOG"
"$HERE/start-session.sh" claude-agent-x /tmp "claude" 2>/dev/null
status=$?
check "start-session refuses a running session" [ "$status" -eq 3 ]
FAKE_DIE=1 "$HERE/start-session.sh" claude-agent-y /tmp "false" 2>/dev/null
status=$?
check "start-session reports a session that ends at once" [ "$status" -eq 2 ]
FAKE_FAIL=1 "$HERE/start-session.sh" claude-agent-z /tmp "true" 2>/dev/null
status=$?
check "start-session reports a tmux failure" [ "$status" -eq 1 ]
: > "$FAKE_LOG"
"$HERE/start-session.sh" claude-agent-w "$CASE/SYNTHETIC_missing_dir" "true" 2>/dev/null
status=$?
check "start-session refuses a missing work directory" [ "$status" -eq 4 ]
check "start-session starts no session in a missing work directory" [ ! -s "$FAKE_LOG" ]

if [ "$FAILURES" -gt 0 ]; then
  printf '%d failed\n' "$FAILURES"
  exit 1
fi
echo "all passed"
