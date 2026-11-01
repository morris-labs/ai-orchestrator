#!/usr/bin/env bash
# Builds the macOS packages of AI Orchestrator into dist/mac/.
#
# Run it on a Mac with the architecture you ship for (arm64 on Apple
# silicon, x64 on Intel): the server's native SQLite module is built for
# the machine that runs `pnpm install`. The script builds every package,
# packs the engine into image/dist/, stages the runtime (Node.js, the
# server, the CLI, the image build context, and the web bundles) with
# scripts/stage-runtime.mjs, and runs electron-builder for both apps. The
# Boxes app (AI Orchestrator.app) carries the runtime in
# Contents/Resources/runtime.
#
# Signing: with CSC_LINK or CSC_NAME set, electron-builder signs with that
# Developer ID identity. Without either, the script turns off identity
# discovery and the apps are ad hoc signed, which runs on the build machine
# but makes Gatekeeper refuse a download elsewhere. Notarization is a TODO;
# see docs/platforms.md.
#
# It needs Node.js 22, pnpm (through corepack), and the Xcode command line
# tools. The script runs with the system bash 3.2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/dist/mac"
INSTALL=1
PRINT=0
REQUIRED_NODE_MAJOR=22
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Builds the AI Orchestrator and AI Orchestrator Review apps for macOS
(dmg and zip) into $OUT_DIR.

Options:
  --arch arm64|x64   The architecture. Default: this Mac's, $ARCH.
                     Another one needs a matching native module; see
                     scripts/stage-runtime.mjs --allow-cross.
  --no-install       Skip \`pnpm install --frozen-lockfile\`.
  --print            Print the steps instead of running them. Works on any
                     host.
  -h, --help         Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --arch) ARCH="${2:?--arch needs arm64 or x64}"; shift ;;
    --no-install) INSTALL=0 ;;
    --print) PRINT=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done
[[ "$ARCH" == arm64 || "$ARCH" == x64 ]] || die "--arch must be arm64 or x64"

PNPM_PRINT="corepack pnpm"
STEPS=(
  "$PNPM_PRINT install --frozen-lockfile"
  "$SCRIPT_DIR/set-version.sh --check"
  "$PNPM_PRINT -r build"
  "$SCRIPT_DIR/build-image.sh --pack-only"
  "node $SCRIPT_DIR/stage-runtime.mjs --os mac --arch $ARCH"
  "(cd apps/boxes && $PNPM_PRINT exec electron-builder --mac --$ARCH --publish never -c.directories.output=$OUT_DIR/boxes)"
  "(cd apps/review && $PNPM_PRINT exec electron-builder --mac --$ARCH --publish never -c.directories.output=$OUT_DIR/review)"
)
if ((PRINT)); then
  ((INSTALL)) || STEPS=("${STEPS[@]:1}")
  printf '%s\n' "${STEPS[@]}"
  exit 0
fi

[[ "$(uname -s)" == Darwin ]] || die "build macOS packages on macOS; this is $(uname -s). Use --print to see the steps."
require_tool node "Install Node.js 22 from https://nodejs.org or with Homebrew: brew install node@22"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == "$REQUIRED_NODE_MAJOR" ]] ||
  die "Node.js $node_major is active, but the build needs Node.js $REQUIRED_NODE_MAJOR, the version the bundled runtime and its native module use."
read -r -a PNPM <<< "$(pnpm_cmd)"

if [[ -z "${CSC_LINK:-}" && -z "${CSC_NAME:-}" ]]; then
  log "No signing identity (CSC_LINK or CSC_NAME); building ad hoc signed apps"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
fi

cd "$ROOT"
if ((INSTALL)); then
  log "Installing dependencies"
  "${PNPM[@]}" install --frozen-lockfile
fi
log "Checking that every package and image/versions.env agree"
"$SCRIPT_DIR/set-version.sh" --check
log "Building every package"
"${PNPM[@]}" -r build
log "Packing the engine"
"$SCRIPT_DIR/build-image.sh" --pack-only
log "Staging the runtime"
node "$SCRIPT_DIR/stage-runtime.mjs" --os mac --arch "$ARCH"
for app in boxes review; do
  log "Building the $app app with electron-builder"
  (cd "$ROOT/apps/$app" && "${PNPM[@]}" exec electron-builder --mac "--$ARCH" --publish never \
    "-c.directories.output=$OUT_DIR/$app")
done
log "Built the macOS packages in $OUT_DIR"
