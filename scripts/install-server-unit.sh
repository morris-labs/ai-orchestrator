#!/usr/bin/env bash
# Remove the former checkout override and use the installed package unit.
# Other drop-ins (credentials, data directory, role) remain in place.
set -euo pipefail
UNIT_HOME="${AIO_HOME:-$HOME}"
UNIT_DIR="$UNIT_HOME/.config/systemd/user"
case "${1:-}" in
  --print)
    printf 'Remove %s/aio-server.service and %s/aio-server.service.d/source-checkout.conf\n' "$UNIT_DIR" "$UNIT_DIR"
    printf 'Use packaged /usr/bin/aio-server; systemctl --user daemon-reload; systemctl --user enable --now aio-server.service\n'
    exit 0 ;;
  -h|--help)
    echo 'Usage: install-server-unit.sh [--print]'
    echo 'Use the installed package unit, removing the former checkout override.'
    exit 0 ;;
  '') ;;
  *) echo 'Use a systemd drop-in for custom settings. See docs/install.md.' >&2; exit 1 ;;
esac
rm -f "$UNIT_DIR/aio-server.service" "$UNIT_DIR/aio-server.service.d/source-checkout.conf"
systemctl --user daemon-reload
systemctl --user enable --now aio-server.service
