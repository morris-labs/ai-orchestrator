#!/usr/bin/env bash
# Starts one conversation as a tmux session in the shared container.
#
# Usage: start-session.sh SESSION WORK_DIR COMMAND
#
#   SESSION   The tmux session name, the box's session.
#   WORK_DIR  The directory the session starts in.
#   COMMAND   The command line to run, already shell-quoted.
#
# Exits 3 when the session already runs, 1 when tmux can't start it, and 2
# when the program ended within two seconds of starting.
S="$1"; D="$2"; CMD="$3"
tmux has-session -t "=$S" 2>/dev/null && { echo "session $S is already running" >&2; exit 3; }
tmux new-session -d -s "$S" -c "$D" -- "$CMD" || exit 1
sleep 2
tmux has-session -t "=$S" 2>/dev/null || { echo "$S ended right after starting" >&2; exit 2; }
