#!/usr/bin/env bash
# Refreshes the pins in image/versions.env: the three agent CLIs from npm
# and the nvm installer from GitHub. With --base, also moves the base image
# digest in image/Dockerfile to the digest ubuntu:26.04 has today.
#
# The script changes only the pinned values and the "Recorded" date. Review
# the diff, rebuild the image, and commit both files together.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSIONS="$ROOT/image/versions.env"
DOCKERFILE="$ROOT/image/Dockerfile"
BASE_TAG="26.04"
BUMP_BASE=0

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--base]

Refreshes the CLI and nvm pins in image/versions.env.

Options:
  --base      Also refresh the ubuntu:$BASE_TAG digest in image/Dockerfile.
  -h, --help  Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --base) BUMP_BASE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

require_tool npm "Install Node.js 22, which includes npm."
require_tool curl "Install curl: sudo apt-get install curl"
require_tool node "Install Node.js 22."

# Replaces the value of KEY in the versions file.
set_pin() {
  local key="$1" value="$2"
  grep -q "^${key}=" "$VERSIONS" || die "$VERSIONS has no $key line"
  sed -i "s|^${key}=.*|${key}=${value}|" "$VERSIONS"
  log "$key=$value"
}

npm_latest() {
  local pkg="$1" v
  v="$(npm view "$pkg" version 2> /dev/null)" || die "npm view $pkg failed; check your network and the npm registry"
  [[ -n "$v" ]] || die "npm returned no version for $pkg"
  printf '%s\n' "$v"
}

set_pin CLAUDE_CODE_VERSION "$(npm_latest @anthropic-ai/claude-code)"
set_pin CODEX_VERSION "$(npm_latest @openai/codex)"
set_pin COPILOT_VERSION "$(npm_latest @github/copilot)"

nvm_tag="$(curl -fsSL https://api.github.com/repos/nvm-sh/nvm/releases/latest |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))')" ||
  die "could not read the latest nvm release from the GitHub API"
set_pin NVM_VERSION "$nvm_tag"

today="$(date +%Y-%m-%d)"
sed -i "s|^# Recorded [0-9-]*\.|# Recorded $today.|" "$VERSIONS"

if ((BUMP_BASE)); then
  token="$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')" ||
    die "could not get a Docker Hub registry token"
  # The header goes through stdin so the token stays out of curl's argv.
  digest="$(printf 'Authorization: Bearer %s\n' "$token" | curl -fsSI \
    -H @- \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
    "https://registry-1.docker.io/v2/library/ubuntu/manifests/$BASE_TAG" |
    tr -d '\r' | sed -n 's/^docker-content-digest: *//Ip')"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "unexpected digest from the registry: '$digest'"
  sed -i "s|^FROM ubuntu:$BASE_TAG@sha256:[0-9a-f]*|FROM ubuntu:$BASE_TAG@$digest|" "$DOCKERFILE"
  sed -i "s|^# Looked up [0-9-]* from registry-1.docker.io|# Looked up $today from registry-1.docker.io|" "$DOCKERFILE"
  log "ubuntu:$BASE_TAG@$digest"
fi

log "Done. Review the changes with: git diff image/"
