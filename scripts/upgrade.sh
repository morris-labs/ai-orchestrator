#!/usr/bin/env bash
# Build the checked-out revision and install it through the package upgrade.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if (($#)); then
  echo 'Usage: scripts/upgrade.sh' >&2
  exit 1
fi
# A private output directory prevents accidentally installing a stale .deb.
UPGRADE_OUT="$(mktemp -d)"
trap 'rm -rf "$UPGRADE_OUT"' EXIT
"$SCRIPT_DIR/build-deb.sh" --out "$UPGRADE_OUT"
FIRST_PACKAGE=0
if [[ "$(dpkg-query -W -f='${Status}' ai-orchestrator 2>/dev/null || true)" != 'install ok installed' ]]; then
  FIRST_PACKAGE=1
  # The old checkout server may still have work open, even on the first
  # package install. The newly built CLI can snapshot its legacy API.
  node "$SCRIPT_DIR/../packages/cli/dist/main.js" upgrade prepare
fi
# Drop the old checkout override before postinst restarts the service.
"$SCRIPT_DIR/install-server-unit.sh" --remove-only
# apt needs to traverse the temporary directory as its sandbox user.
chmod 0755 "$UPGRADE_OUT"
sudo apt install --reinstall "$UPGRADE_OUT"/ai-orchestrator_*.deb

if ((FIRST_PACKAGE)); then
  "$SCRIPT_DIR/install-server-unit.sh"
  systemctl --user restart aio-server.service
  aio upgrade --timeout 300
fi
