#!/usr/bin/env bash
# Makes sure the Electron binary of each desktop app is present.
#
# pnpm downloads the binary in the electron package's install script. That
# script doesn't run when pnpm reuses a module tree that another install
# made, such as one from a box, and `pnpm rebuild electron` then exits 0
# without downloading anything. The package has no dist/ directory and no
# path.txt file, and the apps fail to start. This script finds that state
# and runs the package's own install.js file, which downloads the binary.
#
# The download extracts dist/electron and dist/chrome-sandbox with mode
# 0777 in some environments. Any local user could then replace the binary
# that the dev AppArmor profile grants user namespaces to, so this script
# also removes group and other write permission from everything under
# dist/. It never makes a file more permissive.
#
# Options:
#   --root DIR   The checkout to use. Default: the checkout of this script.
#                Tests point it at a fake checkout.
#   --check      Report a missing binary and exit 1 without downloading or
#                changing modes.
#   -h, --help   Show this help.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
APPS=(boxes review)
CHECK_ONLY=0

while (($#)); do
  case "$1" in
    --root)
      (($# >= 2)) || die "--root needs a directory"
      ROOT="$(cd "$2" && pwd -P)"
      shift
      ;;
    --check) CHECK_ONLY=1 ;;
    -h | --help)
      sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

# Succeeds when the electron package in PKG has its binary.
has_binary() {
  local pkg="$1" rel
  [[ -f "$pkg/path.txt" ]] || return 1
  rel="$(< "$pkg/path.txt")"
  [[ -f "$pkg/dist/$rel" ]]
}

missing=0
declare -A done_pkgs=()
for app in "${APPS[@]}"; do
  link="$ROOT/apps/$app/node_modules/electron"
  [[ -e "$link" ]] ||
    die "$link is missing. Install the workspace first: corepack pnpm install --frozen-lockfile"
  pkg="$(realpath "$link")"
  # Both apps usually share one package in the pnpm store.
  [[ -z "${done_pkgs[$pkg]:-}" ]] || continue
  done_pkgs[$pkg]=1
  if ! has_binary "$pkg"; then
    if ((CHECK_ONLY)); then
      log "Electron binary is missing in $pkg"
      missing=1
      continue
    fi
    [[ -f "$pkg/install.js" ]] || die "$pkg/install.js is missing, so the package is damaged. Reinstall it."
    require_tool node "Install Node.js 22."
    log "Electron binary is missing in $pkg; running its install.js"
    (cd "$pkg" && node install.js) ||
      die "Electron's install.js failed. Check the network, then run this script again."
    has_binary "$pkg" || die "install.js finished, but the binary is still missing in $pkg"
  fi
  if ((!CHECK_ONLY)) && [[ -d "$pkg/dist" ]]; then
    chmod -R go-w -- "$pkg/dist"
  fi
done

exit "$missing"
