#!/usr/bin/env bash
# Host checks for workstream W2 (server services), for the host-side peer
# session. The sandbox has no Docker, ssh, op, or systemd user manager, so
# these run on the real host after W1 and W2 are merged and built.
#
# Run one step at a time: ./host-checks.sh STEP
# Replace the following before you start:
#   BOX_ID:   a running box, such as claude-agent-example
#   PROJECT:  its project id
#   REMOTE:   a saved SSH remote name, such as "Mac Box"; the script encodes it
#   DEV_PORT: a port a dev server listens on inside the box's container
# Set AGENTBOX_DATA_DIR when the server runs with --data-dir.
set -euo pipefail

SERVER="${SERVER:-https://127.0.0.1:21400}"
DATA_DIR="${AGENTBOX_DATA_DIR:-$HOME/.claude-box}"
TOKEN="$(cat "$DATA_DIR/server.token")"
# The server serves HTTPS with its own certificate; curl and websocat trust
# that certificate only.
CERT="$DATA_DIR/server.crt"
curl() { command curl --cacert "$CERT" "$@"; }
websocat() { SSL_CERT_FILE="$CERT" command websocat "$@"; }
H=(-H "Authorization: Bearer ${TOKEN}")
BOX_ID="${BOX_ID:?set BOX_ID}"
PROJECT="${PROJECT:?set PROJECT}"
REMOTE="${REMOTE:-staging}"
DEV_PORT="${DEV_PORT:-5173}"
WS="$(command -v websocat >/dev/null && echo websocat || true)"

# Prints $1 percent-encoded for one URL path segment. Remote names can hold
# spaces, such as "Mac Box".
urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}
REMOTE_PATH="$(urlencode "$REMOTE")"

step="${1:-list}"
case "$step" in
  list)
    sed -n 's/^  \([a-z0-9-]*\))$/\1/p' "$0"
    ;;
  token)
    # Expect mode 600 and a 64-character token.
    stat -c '%a %s' "$DATA_DIR/server.token"
    curl -fsS "$SERVER/api/v1/health"
    curl -s -o /dev/null -w '%{http_code}\n' "$SERVER/api/v1/projects"   # expect 401
    ;;
  routes)
    # Every read route answers 200 against the real core.
    for path in projects boxes settings prompts ssh-remotes global-mounts secrets setup image usage notifications "conversations?dir=$HOME" models; do
      printf '%-20s ' "$path"
      curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" "$SERVER/api/v1/$path"
    done
    ;;
  terminal)
    # Attach to the box's tmux session; type, resize the window, then detach.
    [ -n "$WS" ] || { echo "Install websocat first." >&2; exit 1; }
    "$WS" -b -H "Authorization: Bearer $TOKEN" "wss://127.0.0.1:21400/api/v1/terminals?kind=session&boxId=$BOX_ID&cols=120&rows=40"
    ;;
  shell)
    [ -n "$WS" ] || { echo "Install websocat first." >&2; exit 1; }
    "$WS" -b -H "Authorization: Bearer $TOKEN" "wss://127.0.0.1:21400/api/v1/terminals?kind=shell&projectId=$PROJECT"
    ;;
  events)
    # Send {"type":"hello","streamId":null,"lastSeq":null}; then start and stop a box.
    [ -n "$WS" ] || { echo "Install websocat first." >&2; exit 1; }
    "$WS" -H "Authorization: Bearer $TOKEN" "wss://127.0.0.1:21400/api/v1/events"
    ;;
  proxy)
    # Expect the dev server's page, through the engine's /proxy route.
    KEY="$(curl -fsS "${H[@]}" "$SERVER/api/v1/boxes/$BOX_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["box"]["hostKey"])')"
    curl -sS -o /dev/null -w '%{http_code}\n' "http://$DEV_PORT.$KEY.localhost:21401/"
    ;;
  engine)
    # Expect versionMatches true for the running project container.
    curl -fsS "${H[@]}" "$SERVER/api/v1/projects/$PROJECT"
    ;;
  secrets)
    # Signed in: ok per reference. Locked op: secrets_locked. No values appear.
    curl -fsS "${H[@]}" -H 'content-type: application/json' -d "{\"projectId\":\"$PROJECT\"}" "$SERVER/api/v1/secrets/check"
    ;;
  ssh)
    curl -fsS "${H[@]}" -X POST "$SERVER/api/v1/ssh-remotes/$REMOTE_PATH/test"
    curl -fsS "${H[@]}" "$SERVER/api/v1/ssh-remotes"   # tunnelUp true while a box using it runs
    ;;
  image-build)
    # Starts a job; stream it with:
    #   websocat -b -H "Authorization: Bearer $TOKEN" wss://127.0.0.1:21400/api/v1/jobs/JOB_ID/stream
    curl -fsS "${H[@]}" -H 'content-type: application/json' -d '{"kind":"packages"}' "$SERVER/api/v1/image/build"
    ;;
  setup)
    curl -fsS "${H[@]}" "$SERVER/api/v1/setup"
    ;;
  service)
    # Installs and starts the user unit; expect "active".
    agentbox-server install-service
    systemctl --user is-active agentbox-server.service
    ;;
  shutdown)
    # Expect a clean exit within 10 seconds and no orphaned ssh processes.
    systemctl --user stop agentbox-server.service
    pgrep -a ssh | grep -c ExitOnForwardFailure || true
    ;;
  *)
    echo "Unknown step: $step" >&2
    exit 2
    ;;
esac
