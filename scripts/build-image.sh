#!/usr/bin/env bash
# Builds the AI Orchestrator container image.
#
# In a source checkout, the script deploys @aio/engine with its
# production dependencies at the versions in pnpm-lock.yaml and packs the
# result, node_modules included, into image/dist/. It then runs `docker
# build` on the image/ directory with every pin from image/versions.env as
# a build argument. The image build only unpacks the tarball, so every host
# gets the dependencies the workspace tests ran against, and none come from
# the npm registry. In an installed package (/usr/share/ai-orchestrator), the
# engine tarball ships in image/dist/ already, so the script skips packing.
#
# The CLI versions come from the pins in image/versions.env. With
# --update-cli, the script first resolves the latest versions from npm,
# builds with them and saves the pins only when the build succeeds.
#
# The engine build writes a content hash to dist/identity. The image records
# VERSION+HASH in /etc/aio-engine-version, and the server expects the
# same, so an image built from older engine code reads as stale although the
# package version never changes.
#
# The script runs on Linux, and on macOS with the system bash 3.2 and BSD
# tools, so it avoids associative arrays, `sed -i` without a suffix, and
# GNU-only tar options. On Windows it runs under Git for Windows' bash.
#
# Environment:
#   IMAGE_TAG   The image tag. Default: aio-agent. The --tag option
#               overrides it. Set it to build a test image, such as
#               aio-agent:v4test, without retagging the image that
#               running boxes launch from.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_DIR="$ROOT/image"
TAG="${IMAGE_TAG:-aio-agent}"
PACK=auto
PRINT=0
PACK_ONLY=0
UPDATE_CLI=0
UPGRADE=0
FORWARD_ARGS=()
USER_NAME=""
USER_UID=""
USER_GID=""
BUILD_ARGS=()
VERSIONS="$IMAGE_DIR/versions.env"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Builds the AI Orchestrator image from $IMAGE_DIR.

Options:
  --tag TAG              Tag the image TAG. Default: the IMAGE_TAG variable, else aio-agent.
  --user NAME            Create the image's user as NAME. Default: \$(id -un). The
                         server passes the name it runs containers with on
                         Windows, where the account name isn't a Linux one.
  --uid UID              Give the image's user uid UID. Default: \$(id -u) on Linux,
                         else 1000. On Linux the uid must match the host user's,
                         so the container can read files such as sign-ins that
                         only their owner can read.
  --gid GID              Give the image's user gid GID. Default: \$(id -g) on Linux,
                         else 1000.
  --upgrade              Build latest CLIs, fall back to pins on failure, and keep one previous image.
  --update-cli           Update the agent CLIs to their latest versions. Resolves
                         the latest Claude Code, Codex, and Copilot versions from
                         npm, saves them to $VERSIONS after a successful build
                         (when the file is writable), and builds with them. Also
                         rebuilds the CLI and engine layers
                         (--build-arg CACHEBUST=<now>). Without this option, the
                         build uses the versions pinned in that file.
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
  [[ "$1" == --upgrade ]] || FORWARD_ARGS+=("$1")
  case "$1" in
    --tag) FORWARD_ARGS+=("$2"); TAG="${2:?--tag needs a value}"; shift ;;
    --user) FORWARD_ARGS+=("$2"); USER_NAME="${2:?--user needs a value}"; shift ;;
    --uid) FORWARD_ARGS+=("$2"); USER_UID="${2:?--uid needs a value}"; shift ;;
    --gid) FORWARD_ARGS+=("$2"); USER_GID="${2:?--gid needs a value}"; shift ;;
    --upgrade) UPGRADE=1 ;;
    --update-cli) UPDATE_CLI=1; BUILD_ARGS+=(--build-arg "CACHEBUST=$(date +%s)") ;;
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

# Jobs stop the script at their deadline. Forward that signal through the
# upgrade wrapper and its build child so Docker cannot outlive the upgrade.
run_build() {
  "$@" &
  build_pid=$!
  trap 'kill -TERM "$build_pid" 2>/dev/null || true; wait "$build_pid" 2>/dev/null || true; exit 143' TERM INT
  local result=0
  wait "$build_pid" || result=$?
  trap - TERM INT
  return "$result"
}

[[ -f "$IMAGE_DIR/Dockerfile" ]] || die "no Dockerfile in $IMAGE_DIR"

# The same entry point serves package installs, startup recovery and CLI updates.
# Retag only after a successful build; a failed pair leaves the current image intact.
if ((UPGRADE)); then
  previous_repo="${TAG%:*}-upgrade"
  old_current="$(docker image inspect --format '{{.Id}}' "$TAG" 2>/dev/null || true)"
  old_previous="$(docker image inspect --format '{{.Id}}' "$previous_repo:previous" 2>/dev/null || true)"
  if run_build "$0" "${FORWARD_ARGS[@]}" --update-cli; then
    echo 'AIO_UPGRADE_IMAGE=latest'
  else
    log "Latest agent CLIs failed; falling back to pinned versions"
    run_build "$0" "${FORWARD_ARGS[@]}"
    echo 'AIO_UPGRADE_IMAGE=pinned'
  fi
  current="$(docker image inspect --format '{{.Id}}' "$TAG")"
  if [[ -n "$old_current" && "$old_current" != "$current" ]]; then
    docker image tag "$old_current" "$previous_repo:previous"
    if [[ -n "$old_previous" && "$old_previous" != "$old_current" && "$old_previous" != "$current" ]]; then
      # A container or another tag can still use the older image. Keeping it
      # costs disk space only, so the upgrade goes on.
      docker image rm "$old_previous" >/dev/null 2>&1 ||
        log "Kept the older image $old_previous; a container or tag still uses it"
    fi
  fi
  exit 0
fi


# --update-cli: resolve the latest CLI versions from npm. OVERRIDE_KEYS and
# OVERRIDE_VALUES hold them for this build (two plain arrays, since macOS
# bash 3.2 has no associative arrays); the pins file records them when it's
# writable. In an installed package the file belongs to root, so the build
# still uses the new versions and the script says it can't save them.
OVERRIDE_KEYS=()
OVERRIDE_VALUES=()
if ((!UPDATE_CLI)) && [[ ! -w "$VERSIONS" ]]; then
  saved_pins="${AIO_DATA_DIR:-$HOME/.ai-orchestrator}/cli-versions.env"
  if [[ -f "$saved_pins" ]]; then
    OVERRIDE_KEYS=(CLAUDE_CODE_VERSION CODEX_VERSION COPILOT_VERSION)
    for key in "${OVERRIDE_KEYS[@]}"; do
      OVERRIDE_VALUES+=("$(version_of "$saved_pins" "$key")")
    done
  fi
fi

# Prints the override of KEY, or nothing.
override_of() {
  local i
  for ((i = 0; i < ${#OVERRIDE_KEYS[@]}; i++)); do
    [[ "${OVERRIDE_KEYS[i]}" == "$1" ]] && { printf '%s' "${OVERRIDE_VALUES[i]}"; return; }
  done
  return 0
}

if ((UPDATE_CLI && !PACK_ONLY)); then
  # The macOS and Windows packages bundle npm in the runtime that holds this
  # script's share folder, and the host might have no Node.js. The
  # runtime.json file marks such a runtime.
  if [[ -f "$ROOT/../runtime.json" ]]; then
    for dir in "$ROOT/../node/bin" "$ROOT/../node"; do
      if [[ -f "$dir/npm" ]]; then
        PATH="$(cd "$dir" && pwd):$PATH"
        break
      fi
    done
  fi
  require_tool npm "Install Node.js 22, which includes npm."
  OVERRIDE_KEYS=(CLAUDE_CODE_VERSION CODEX_VERSION COPILOT_VERSION)
  # npm_latest exits only its command substitution when it fails. A simple
  # assignment passes that failure to set -e; an array assignment hides it.
  claude_code_version="$(npm_latest @anthropic-ai/claude-code)"
  codex_version="$(npm_latest @openai/codex)"
  copilot_version="$(npm_latest @github/copilot)"
  OVERRIDE_VALUES=("$claude_code_version" "$codex_version" "$copilot_version")

fi
ENGINE_VERSION="$(version_of "$VERSIONS" AIO_ENGINE_VERSION)"
ENGINE_TARBALL="$IMAGE_DIR/dist/aio-engine-$ENGINE_VERSION.tgz"

if ((PACK_ONLY)) && [[ ! -f "$ROOT/pnpm-workspace.yaml" ]]; then
  die "--pack-only needs a source checkout with pnpm-workspace.yaml"
fi
if [[ "$PACK" == auto && -f "$ROOT/pnpm-workspace.yaml" ]]; then
  [[ -f "$ROOT/packages/engine/package.json" ]] || die "packages/engine is missing from the workspace"
  read -r -a PNPM <<< "$(pnpm_cmd)"
  log "Building @aio/engine and its workspace dependencies"
  (cd "$ROOT" && "${PNPM[@]}" --filter "@aio/engine..." build)
  log "Packing the engine and its locked dependencies into $IMAGE_DIR/dist"
  rm -rf "$IMAGE_DIR/dist"
  mkdir -p "$IMAGE_DIR/dist"
  DEPLOY="$(mktemp -d)"
  # A failed deploy or tar under set -e must not leave a node_modules tree
  # behind in the temporary directory.
  trap 'rm -rf -- "$DEPLOY"' EXIT
  # pnpm deploy installs from pnpm-lock.yaml and copies workspace packages,
  # such as @aio/contracts, into node_modules. Its symlinks are
  # relative, so the tree works wherever the Dockerfile unpacks it.
  (cd "$ROOT" && "${PNPM[@]}" --filter @aio/engine deploy --legacy --prod --frozen-lockfile "$DEPLOY/engine" > /dev/null)
  [[ -d "$DEPLOY/engine/node_modules" ]] || die "pnpm deploy left no node_modules in $DEPLOY/engine"
  # The box user, not root, runs the engine, so every file must be readable
  # by all. pnpm deploy can leave folders at mode 0700.
  chmod -R u=rwX,go=rX "$DEPLOY/engine"
  # GNU tar and bsdtar (macOS, Windows) name the owner options differently.
  if tar --version 2> /dev/null | grep -q 'GNU tar'; then
    tar -C "$DEPLOY" --owner=0 --group=0 --numeric-owner -czf "$ENGINE_TARBALL" engine
  else
    tar -C "$DEPLOY" --uid 0 --gid 0 --numeric-owner -czf "$ENGINE_TARBALL" engine
  fi
  # The server in an installed package expects the engine's content hash, and
  # reads it from here. The Dockerfile reads the same hash from the tarball.
  [[ -s "$DEPLOY/engine/dist/identity" ]] ||
    die "the engine build wrote no dist/identity; check the build script of packages/engine"
  cp "$DEPLOY/engine/dist/identity" "$IMAGE_DIR/dist/engine-identity"
  rm -rf -- "$DEPLOY"
  trap - EXIT
fi

[[ -f "$ENGINE_TARBALL" ]] ||
  die "$ENGINE_TARBALL is missing. Its version must match AIO_ENGINE_VERSION in $VERSIONS; run scripts/set-version.sh to align them."
((PACK_ONLY)) && { log "Packed $ENGINE_TARBALL"; exit 0; }
for f in keeper/keeper.sh keeper/start-session.sh; do
  [[ -f "$IMAGE_DIR/$f" ]] || die "$IMAGE_DIR/$f is missing"
done

[[ -n "$USER_NAME" ]] || USER_NAME="$(id -un)"
# Docker Desktop on macOS and Windows maps bind mount ownership itself, so
# the uid and gid stay 1000 there.
if [[ "$(uname -s)" == Linux ]]; then
  [[ -n "$USER_UID" ]] || USER_UID="$(id -u)"
  [[ -n "$USER_GID" ]] || USER_GID="$(id -g)"
fi
[[ -n "$USER_UID" ]] || USER_UID=1000
[[ -n "$USER_GID" ]] || USER_GID=1000
[[ "$USER_UID" =~ ^[0-9]+$ && "$USER_GID" =~ ^[0-9]+$ ]] || die "--uid and --gid take numbers."
[[ "$USER_UID" != 0 && "$USER_GID" != 0 ]] ||
  die "The image's user can't be root. Run this script as the user who runs the server, or pass --uid and --gid."
CMD=(docker build -t "$TAG" --build-arg "USER_NAME=$USER_NAME"
  --build-arg "USER_UID=$USER_UID" --build-arg "USER_GID=$USER_GID")
while IFS= read -r pair; do
  override="$(override_of "${pair%%=*}")"
  [[ -n "$override" ]] && pair="${pair%%=*}=$override"
  CMD+=(--build-arg "$pair")
done < <(read_versions "$VERSIONS")
# Bash 3.2 treats an empty array as unset under `set -u`.
CMD+=(${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} "$IMAGE_DIR")

if ((PRINT)); then
  printf '%q ' "${CMD[@]}"
  printf '\n'
  exit 0
fi

require_tool docker "Install Docker Engine (docker.io or docker-ce) and add your user to the docker group."
# The Dockerfile uses COPY --chmod, which the legacy builder rejects.
docker buildx version > /dev/null 2>&1 ||
  die "The image build needs BuildKit. Install the docker-buildx or docker-buildx-plugin package."
log "Building image $TAG for user $USER_NAME (uid $USER_UID, gid $USER_GID)"
# Keep the process stoppable while retaining the successful pins afterward.
run_build "${CMD[@]}"
# A failed build must leave the known working pins intact. Installed packages
# are root-owned: keep successful CLI pins in the user's data directory too.
if ((UPDATE_CLI)); then
  if [[ -w "$VERSIONS" ]]; then
    pin_target="$VERSIONS"
  else
    pin_dir="${AIO_DATA_DIR:-$HOME/.ai-orchestrator}"
    mkdir -p "$pin_dir"
    log "warning: $VERSIONS isn't writable; saving successful CLI pins in $pin_dir"
    saved_pin_target="$pin_dir/cli-versions.env"
    pin_target="$saved_pin_target.tmp"
    cp "$VERSIONS" "$pin_target"
    chmod u+w "$pin_target"
  fi
  for ((i = 0; i < ${#OVERRIDE_KEYS[@]}; i++)); do
    set_pin "$pin_target" "${OVERRIDE_KEYS[i]}" "${OVERRIDE_VALUES[i]}"
  done
fi

if [[ -n "${saved_pin_target:-}" ]]; then
  mv -f "$pin_target" "$saved_pin_target"
fi
