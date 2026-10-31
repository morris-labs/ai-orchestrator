#!/usr/bin/env bash
# Installs the agentbox-server systemd user unit for this source checkout.
#
# The script writes a drop-in that puts this checkout's Node.js directory on
# the service's PATH, then runs `agentbox-server install-service` from
# packages/server/dist, which writes
# ~/.config/systemd/user/agentbox-server.service with an ExecStart= line
# that names this Node.js and this checkout, reloads systemd, and enables
# and starts the service. The image build in a source checkout runs pnpm
# through corepack, which lives beside node, and the systemd user manager's
# PATH might not include that directory.
#
# Other files in agentbox-server.service.d/, such as a drop-in that loads
# the 1Password service account token with EnvironmentFile=, stay in place
# and apply to the unit.
#
# Environment:
#   AGENTBOX_DATA_DIR  The server's data directory. The unit's ExecStart=
#                      line gets it as --data-dir. Default: ~/.claude-box.
#   AGENTBOX_HOME      The home directory to install under in place of
#                      yours, as the server reads it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAIN="$ROOT/packages/server/dist/main.js"
UNIT_HOME="${AGENTBOX_HOME:-$HOME}"
DROPIN_DIR="$UNIT_HOME/.config/systemd/user/agentbox-server.service.d"
DROPIN="$DROPIN_DIR/source-checkout.conf"
PRINT=0
SERVER_ARGS=()

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Installs, enables, and starts the agentbox-server systemd user unit that
runs the server from $ROOT.

Options:
  --data-dir PATH   Run the server with the data directory PATH.
                    Default: the AGENTBOX_DATA_DIR variable, else ~/.claude-box.
  --print           Print the drop-in and the command instead of running them.
  -h, --help        Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --data-dir) SERVER_ARGS+=(--data-dir "${2:?--data-dir needs a directory}"); shift ;;
    --data-dir=*) SERVER_ARGS+=("$1") ;;
    --print) PRINT=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

require_tool node "Install Node.js 22 or later."
NODE="$(node -p process.execPath)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
((NODE_MAJOR >= 22)) || die "Node.js 22 or later is required; $NODE is version $NODE_MAJOR."
[[ -f "$MAIN" ]] ||
  die "$MAIN is missing. Build the workspace first: corepack pnpm install --frozen-lockfile && corepack pnpm -r build"

# Quotes VALUE for a double-quoted systemd setting: backslashes and quotes
# are escaped, and % is doubled so systemd doesn't read it as a specifier.
systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

NODE_DIR="$(dirname "$NODE")"
DROPIN_TEXT="# Written by scripts/install-server-unit.sh for the checkout in $ROOT.
# The image build runs pnpm through corepack, which lives beside node.
[Service]
Environment=\"PATH=$(systemd_quote "$NODE_DIR"):%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"
"
CMD=("$NODE" "$MAIN" "${SERVER_ARGS[@]}" install-service)

if ((PRINT)); then
  printf '# %s\n%s\n' "$DROPIN" "$DROPIN_TEXT"
  printf '%q ' "${CMD[@]}"
  printf '\n'
  exit 0
fi

mkdir -p "$DROPIN_DIR"
printf '%s' "$DROPIN_TEXT" > "$DROPIN"
log "Wrote $DROPIN"
"${CMD[@]}"
