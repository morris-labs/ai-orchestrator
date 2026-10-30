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
TOKEN_FILE="$DATA_DIR/server.token"
[ -r "$TOKEN_FILE" ] || { echo "Can't read $TOKEN_FILE." >&2; exit 1; }
# curl reads the Authorization header from a file that only you can read,
# so the token never appears in a process's argument list, where other
# local users can see it with ps.
HEADER_FILE="$(umask 077 && mktemp)"
trap 'rm -f "$HEADER_FILE"' EXIT
printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$HEADER_FILE"
H=(-H "@$HEADER_FILE")
# The server serves HTTPS with its own certificate; curl and node trust
# that certificate only.
CERT="$DATA_DIR/server.crt"
curl() { command curl --cacert "$CERT" "$@"; }
BOX_ID="${BOX_ID:?set BOX_ID}"
PROJECT="${PROJECT:?set PROJECT}"
REMOTE="${REMOTE:-staging}"
DEV_PORT="${DEV_PORT:-5173}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Opens a WebSocket with the token from TOKEN_FILE: ws URL [--binary].
ws() { NODE_EXTRA_CA_CERTS="$CERT" node "$HERE/ws-client.mjs" "${@:2}" "$TOKEN_FILE" "$1"; }

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
    ws "wss://127.0.0.1:21400/api/v1/terminals?kind=session&boxId=$BOX_ID&cols=120&rows=40" --binary
    ;;
  shell)
    ws "wss://127.0.0.1:21400/api/v1/terminals?kind=shell&projectId=$PROJECT" --binary
    ;;
  events)
    # Send {"type":"hello","streamId":null,"lastSeq":null}; then start and stop a box.
    ws "wss://127.0.0.1:21400/api/v1/events"
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
    #   node packages/server/test/host/ws-client.mjs --binary TOKEN_FILE \
    #     wss://127.0.0.1:21400/api/v1/jobs/JOB_ID/stream
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
