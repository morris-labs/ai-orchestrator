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
# Drop the old checkout override before postinst restarts the service.
"$SCRIPT_DIR/install-server-unit.sh"
# apt needs to traverse the temporary directory as its sandbox user.
chmod 0755 "$UPGRADE_OUT"
sudo apt install --reinstall "$UPGRADE_OUT"/ai-orchestrator_*.deb
