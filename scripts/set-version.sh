#!/usr/bin/env bash
# Sets the AI Orchestrator version in every workspace package.json and in the
# AIO_ENGINE_VERSION pin of image/versions.env, or checks that they
# agree.
#
# A workspace package.json is the root one or any package.json under
# packages/, apps/, or tools/ (one level deep) whose name starts with
# "@aio/". Fixtures with other names keep their own versions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="${AIO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
VERSIONS="$ROOT/image/versions.env"

usage() {
  cat <<USAGE
Usage: $(basename "$0") VERSION
       $(basename "$0") --check

Sets VERSION (for example, 1.0.0 or 1.1.0-rc.1) in every workspace
package.json and in image/versions.env, or with --check, exits with status 1
when they disagree.
USAGE
}

(($# == 1)) || { usage >&2; exit 2; }
case "$1" in
  -h | --help) usage; exit 0 ;;
esac

require_tool node "Install Node.js 22."

# Prints every workspace package.json path, root first.
manifests() {
  local f
  printf '%s\n' "$ROOT/package.json"
  for f in "$ROOT"/packages/*/package.json "$ROOT"/apps/*/package.json "$ROOT"/tools/*/package.json; do
    [[ -f "$f" ]] || continue
    node -e 'process.exit(require(process.argv[1]).name?.startsWith("@aio/") ? 0 : 1)' "$f" &&
      printf '%s\n' "$f"
  done
}

if [[ "$1" == "--check" ]]; then
  expected="$(version_of "$VERSIONS" AIO_ENGINE_VERSION)"
  bad=0
  while IFS= read -r f; do
    v="$(node -p 'require(process.argv[1]).version' "$f")"
    if [[ "$v" != "$expected" ]]; then
      printf 'version mismatch: %s has %s, image/versions.env has %s\n' "${f#"$ROOT"/}" "$v" "$expected" >&2
      bad=1
    fi
  done < <(manifests)
  ((bad == 0)) || die "versions disagree; run scripts/set-version.sh VERSION"
  log "Every package and image/versions.env are at $expected"
  exit 0
fi

VERSION="$1"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  die "not a semantic version: $VERSION (expected X.Y.Z or X.Y.Z-PRERELEASE)"

while IFS= read -r f; do
  # Rewrites only the top-level "version" line, so the rest of the file
  # keeps its formatting.
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const re = /^(  "version":\s*")[^"]*(")/m;
    if (!re.test(text)) { console.error(`${file}: no top-level "version" field`); process.exit(1); }
    fs.writeFileSync(file, text.replace(re, `$1${version}$2`));
  ' "$f" "$VERSION"
  log "${f#"$ROOT"/}: $VERSION"
done < <(manifests)

grep -q '^AIO_ENGINE_VERSION=' "$VERSIONS" || die "$VERSIONS has no AIO_ENGINE_VERSION line"
sed -i "s|^AIO_ENGINE_VERSION=.*|AIO_ENGINE_VERSION=$VERSION|" "$VERSIONS"
log "image/versions.env: $VERSION"
