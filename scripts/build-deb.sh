#!/usr/bin/env bash
# Builds ai-orchestrator_<version>_amd64.deb from the workspace.
#
# The script builds every package, assembles a staging tree, and runs nfpm
# with packaging/deb/nfpm.yaml. It needs Node.js 22, pnpm (through
# corepack), nfpm, and electron-builder (a dev dependency of both apps).
# The package lands in dist/ at the repository root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$ROOT/dist"
STAGE="$ROOT/packaging/deb/build"
INSTALL=1
REQUIRED_NODE_MAJOR=22

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Builds the ai-orchestrator .deb into $OUT_DIR.

Options:
  --no-install   Skip \`pnpm install --frozen-lockfile\`.
  --out DIR      Write the package to DIR, relative to the current
                 directory. Default: dist/ at the repository root.
  -h, --help     Show this help.

Environment:
  AIO_ALLOW_NODE_MAJOR  Build with this Node.js major version instead
                             of $REQUIRED_NODE_MAJOR. The server's native modules then
                             won't load on the Node.js 22 the package
                             depends on, so use it only for local tests.
USAGE
}

while (($#)); do
  case "$1" in
    --no-install) INSTALL=0 ;;
    # nfpm runs from the staging directory, so a relative DIR is resolved
    # against the directory you run the script from.
    --out)
      OUT_DIR="${2:?--out needs a directory}"
      [[ "$OUT_DIR" == /* ]] || OUT_DIR="$PWD/$OUT_DIR"
      shift
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# Check every tool before doing any work, so a missing tool fails in a
# second instead of after a ten-minute build.
require_tool node "Install Node.js 22 from NodeSource: https://github.com/nodesource/distributions"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" != "${AIO_ALLOW_NODE_MAJOR:-$REQUIRED_NODE_MAJOR}" ]]; then
  die "Node.js $node_major is active, but the package must be built with Node.js $REQUIRED_NODE_MAJOR, the version its native modules target. Switch with nvm, or set AIO_ALLOW_NODE_MAJOR=$node_major for a local test build."
fi
read -r -a PNPM <<< "$(pnpm_cmd)"
require_tool nfpm "Install nfpm from https://nfpm.goreleaser.com/install/ (for example: go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest)."
require_tool dpkg-deb "Install dpkg: sudo apt-get install dpkg"
UNIT="$ROOT/packaging/systemd/aio-server.service"
[[ -f "$UNIT" ]] || die "$UNIT is missing; the server workstream provides it."
for app in boxes review; do
  [[ -f "$ROOT/apps/$app/package.json" ]] || die "apps/$app is missing"
done
for f in keeper/keeper.sh keeper/start-session.sh; do
  [[ -f "$ROOT/image/$f" ]] || die "image/$f is missing"
done

log "Checking that every package and image/versions.env agree"
"$SCRIPT_DIR/set-version.sh" --check
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"

cd "$ROOT"
if ((INSTALL)); then
  log "Installing dependencies"
  "${PNPM[@]}" install --frozen-lockfile
fi
for app in boxes review; do
  (cd "$ROOT/apps/$app" && "${PNPM[@]}" exec electron-builder --version > /dev/null 2>&1) ||
    die "electron-builder is not available in apps/$app. Add it as a dev dependency of that app, then run: corepack pnpm install"
done

log "Building every package"
"${PNPM[@]}" -r build

rm -rf "$STAGE"
R="$STAGE/root"
mkdir -p "$R/usr/bin" "$R/usr/lib/ai-orchestrator" "$R/usr/share/ai-orchestrator" \
  "$R/usr/share/applications" "$R/usr/share/icons/hicolor/scalable/apps" \
  "$R/usr/lib/systemd/user" "$R/etc/apparmor.d" "$R/etc/ufw/applications.d" "$STAGE/maint"

# Writes /usr/bin/NAME, a launcher that runs the package's bin entry NAME
# from /usr/lib/ai-orchestrator/DIR on the system Node.js.
write_launcher() {
  local name="$1" dir="$2" bin
  # shellcheck disable=SC2016 # JavaScript, not shell
  bin="$(node -p '
    const p = require(process.argv[1]);
    const b = typeof p.bin === "string" ? p.bin : (p.bin ?? {})[process.argv[2]];
    if (!b) { console.error(`${p.name} has no bin entry ${process.argv[2]}`); process.exit(1); }
    b.replace(/^\.\//, "")' "$R/usr/lib/ai-orchestrator/$dir/package.json" "$name")"
  [[ -f "$R/usr/lib/ai-orchestrator/$dir/$bin" ]] || die "$dir/$bin does not exist after the build"
  printf '#!/bin/sh\nexec /usr/bin/node /usr/lib/ai-orchestrator/%s/%s "$@"\n' "$dir" "$bin" > "$R/usr/bin/$name"
  chmod 0755 "$R/usr/bin/$name"
}

log "Staging the server and the CLI"
"${PNPM[@]}" --filter @aio/server deploy --legacy --prod "$R/usr/lib/ai-orchestrator/server"
"${PNPM[@]}" --filter @aio/cli deploy --legacy --prod "$R/usr/lib/ai-orchestrator/cli"
write_launcher aio-server server
write_launcher aio cli

for app in boxes review; do
  log "Building the $app app with electron-builder"
  out="$STAGE/electron-$app"
  (cd "$ROOT/apps/$app" && "${PNPM[@]}" exec electron-builder --linux --x64 --dir --publish never \
    "-c.directories.output=$out" "-c.linux.executableName=aio-$app")
  [[ -x "$out/linux-unpacked/aio-$app" ]] ||
    die "electron-builder produced no $out/linux-unpacked/aio-$app"
  cp -a "$out/linux-unpacked" "$R/usr/lib/ai-orchestrator/$app"
  # The server serves the renderer bundle from here; the copy inside
  # app.asar is readable only by Electron.
  [[ -f "$ROOT/apps/$app/dist/renderer/index.html" ]] || die "apps/$app/dist/renderer has no index.html"
  mkdir -p "$R/usr/share/ai-orchestrator/web"
  cp -a "$ROOT/apps/$app/dist/renderer" "$R/usr/share/ai-orchestrator/web/$app"
  install -m 0644 "$ROOT/packaging/desktop/aio-$app.desktop" "$R/usr/share/applications/"
  install -m 0644 "$ROOT/packaging/icons/aio-$app.svg" "$R/usr/share/icons/hicolor/scalable/apps/"
  install -m 0644 "$ROOT/packaging/deb/apparmor/aio-$app" "$R/etc/apparmor.d/"
done

install -m 0644 "$UNIT" "$R/usr/lib/systemd/user/"
install -m 0644 "$ROOT/packaging/ufw/aio-hub" "$R/etc/ufw/applications.d/"

log "Staging the image build context"
"$SCRIPT_DIR/build-image.sh" --pack-only
IMG="$R/usr/share/ai-orchestrator/image"
mkdir -p "$IMG/keeper" "$IMG/dist"
install -m 0644 "$ROOT/image/Dockerfile" "$ROOT/image/versions.env" "$ROOT/image/.dockerignore" "$IMG/"
install -m 0755 "$ROOT/image/keeper/keeper.sh" "$ROOT/image/keeper/start-session.sh" "$IMG/keeper/"
install -m 0644 "$ROOT"/image/dist/*.tgz "$ROOT/image/dist/engine-identity" "$IMG/dist/"
mkdir -p "$R/usr/share/ai-orchestrator/scripts/lib"
install -m 0755 "$SCRIPT_DIR/build-image.sh" "$R/usr/share/ai-orchestrator/scripts/"
install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$R/usr/share/ai-orchestrator/scripts/lib/"

# The build's umask can leave staged files group-writable. Remove group and
# other write permission so that only root can write the installed files.
# chrome-sandbox keeps mode 0755 here; postinst adds the setuid bit only on
# hosts where the app can't use user namespaces.
chmod -R go-w "$R"

install -m 0755 "$ROOT/packaging/deb/scripts/postinst" "$ROOT/packaging/deb/scripts/prerm" \
  "$ROOT/packaging/deb/scripts/postrm" "$STAGE/maint/"

mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/ai-orchestrator_${VERSION}_amd64.deb"
log "Packaging $DEB"
(cd "$STAGE" && AIO_VERSION="$VERSION" nfpm package \
  --config "$ROOT/packaging/deb/nfpm.yaml" --packager deb --target "$DEB")
dpkg-deb --info "$DEB" > /dev/null || die "dpkg-deb can't read $DEB"
log "Built $DEB"
