#!/usr/bin/env bash
# Builds the Agent Box container image.
#
# In a source checkout, the script deploys @agentbox/engine with its
# production dependencies at the versions in pnpm-lock.yaml and packs the
# result, node_modules included, into image/dist/. It then runs `docker
# build` on the image/ directory with every pin from image/versions.env as
# a build argument. The image build only unpacks the tarball, so every host
# gets the dependencies the workspace tests ran against, and none come from
# the npm registry. In an installed package (/usr/share/agentbox), the
# engine tarball ships in image/dist/ already, so the script skips packing.
#
# Environment:
#   IMAGE_TAG   The image tag. Default: claude-code. The --tag option
#               overrides it. Set it to build a test image, such as
#               claude-code:v4test, without retagging the image that
#               running boxes launch from.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_DIR="$ROOT/image"
TAG="${IMAGE_TAG:-claude-code}"
PACK=auto
PRINT=0
PACK_ONLY=0
BUILD_ARGS=()

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Builds the Agent Box image from $IMAGE_DIR.

Options:
  --tag TAG              Tag the image TAG. Default: the IMAGE_TAG variable, else claude-code.
  --update-cli           Rebuild the agent CLI and engine layers
                         (--build-arg CACHEBUST=<now>).
  --update-packages      Rebuild every layer after the base image
                         (--build-arg CACHEBUST_PACKAGES=<now>).
  --no-cache             Pass --no-cache --pull to docker build.
  --no-pack              Use the tarball already in image/dist/.
  --pack-only            Pack the engine into image/dist/ and stop.
  --print                Print the docker build command instead of running it.
  -h, --help             Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift ;;
    --update-cli) BUILD_ARGS+=(--build-arg "CACHEBUST=$(date +%s)") ;;
    --update-packages) BUILD_ARGS+=(--build-arg "CACHEBUST_PACKAGES=$(date +%s)") ;;
    --no-cache) BUILD_ARGS+=(--no-cache --pull) ;;
    --no-pack) PACK=no ;;
    --pack-only) PACK_ONLY=1 ;;
    --print) PRINT=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

[[ -f "$IMAGE_DIR/Dockerfile" ]] || die "no Dockerfile in $IMAGE_DIR"
VERSIONS="$IMAGE_DIR/versions.env"
ENGINE_VERSION="$(version_of "$VERSIONS" AGENTBOX_ENGINE_VERSION)"
ENGINE_TARBALL="$IMAGE_DIR/dist/agentbox-engine-$ENGINE_VERSION.tgz"

if ((PACK_ONLY)) && [[ ! -f "$ROOT/pnpm-workspace.yaml" ]]; then
  die "--pack-only needs a source checkout with pnpm-workspace.yaml"
fi
if [[ "$PACK" == auto && -f "$ROOT/pnpm-workspace.yaml" ]]; then
  [[ -f "$ROOT/packages/engine/package.json" ]] || die "packages/engine is missing from the workspace"
  read -r -a PNPM <<< "$(pnpm_cmd)"
  log "Building @agentbox/engine and its workspace dependencies"
  (cd "$ROOT" && "${PNPM[@]}" --filter "@agentbox/engine..." build)
  log "Packing the engine and its locked dependencies into $IMAGE_DIR/dist"
  rm -rf "$IMAGE_DIR/dist"
  mkdir -p "$IMAGE_DIR/dist"
  DEPLOY="$(mktemp -d)"
  # pnpm deploy installs from pnpm-lock.yaml and copies workspace packages,
  # such as @agentbox/contracts, into node_modules. Its symlinks are
  # relative, so the tree works wherever the Dockerfile unpacks it.
  (cd "$ROOT" && "${PNPM[@]}" --filter @agentbox/engine deploy --legacy --prod --frozen-lockfile "$DEPLOY/engine" > /dev/null)
  [[ -d "$DEPLOY/engine/node_modules" ]] || die "pnpm deploy left no node_modules in $DEPLOY/engine"
  tar -C "$DEPLOY" --owner=0 --group=0 --numeric-owner -czf "$ENGINE_TARBALL" engine
  rm -rf "$DEPLOY"
fi

[[ -f "$ENGINE_TARBALL" ]] ||
  die "$ENGINE_TARBALL is missing. Its version must match AGENTBOX_ENGINE_VERSION in $VERSIONS; run scripts/set-version.sh to align them."
((PACK_ONLY)) && { log "Packed $ENGINE_TARBALL"; exit 0; }
for f in keeper/keeper.sh keeper/start-session.sh; do
  [[ -f "$IMAGE_DIR/$f" ]] || die "$IMAGE_DIR/$f is missing"
done

USER_NAME="$(id -un)"
CMD=(docker build -t "$TAG" --build-arg "USER_NAME=$USER_NAME")
while IFS= read -r pair; do
  CMD+=(--build-arg "$pair")
done < <(read_versions "$VERSIONS")
CMD+=("${BUILD_ARGS[@]}" "$IMAGE_DIR")

if ((PRINT)); then
  printf '%q ' "${CMD[@]}"
  printf '\n'
  exit 0
fi

require_tool docker "Install Docker Engine (docker.io or docker-ce) and add your user to the docker group."
log "Building image $TAG for user $USER_NAME"
# Replace this shell with the docker client, so a signal to the job reaches it.
exec "${CMD[@]}"
