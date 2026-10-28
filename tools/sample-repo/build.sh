#!/usr/bin/env bash
# Builds the sample repository for the engine tests.
#
# Usage: build.sh DEST
#
# Creates DEST/repo, a working repository with a `main` branch and a
# `feature` branch carrying the planted bugs in scenario/bugs.json, and
# DEST/origin.git, a bare repository that `origin` points at, holding `main`.
# The policy file goes to DEST/repo/.claude-box/policy.yaml, which git
# excludes. DEST must not exist yet or must be empty.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 DEST" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$1"
mkdir -p "$dest"
if [[ -n "$(ls -A "$dest")" ]]; then
  echo "error: $dest is not empty" >&2
  exit 1
fi
dest="$(cd "$dest" && pwd)"
repo="$dest/repo"

# Fixed identities and dates make every build produce the same commits.
export GIT_AUTHOR_NAME="Sample Author" GIT_AUTHOR_EMAIL="author@example.com"
export GIT_COMMITTER_NAME="Sample Author" GIT_COMMITTER_EMAIL="author@example.com"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

commit() {
  local date="$1" message="$2"
  find "$repo" -name __pycache__ -prune -exec rm -rf {} +
  git -C "$repo" add -A
  GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" git -C "$repo" commit -q -m "$message"
}

git init -q -b main "$repo"
git -C "$repo" config user.name "Sample Author"
git -C "$repo" config user.email "author@example.com"
git -C "$repo" config commit.gpgsign false

cp -r "$here/main/." "$repo/"
commit "2026-01-01T10:00:00Z" "Add the shop library"

git init -q --bare -b main "$dest/origin.git"
git -C "$repo" remote add origin "$dest/origin.git"
git -C "$repo" push -q origin main
git -C "$repo" fetch -q origin

git -C "$repo" checkout -q -b feature
cp "$here/feature/shop/pricing.py" "$here/feature/shop/inventory.py" "$repo/shop/"
cp "$here/feature/tests/test_pricing.py" "$here/feature/tests/test_inventory.py" "$repo/tests/"
commit "2026-01-02T10:00:00Z" "Add bulk discounts, averages, and paging"
cp "$here/feature/shop/reports.py" "$repo/shop/"
cp "$here/feature/tests/test_reports.py" "$repo/tests/"
mkdir -p "$repo/docs"
cp "$here/feature/docs/reports.md" "$repo/docs/"
commit "2026-01-03T10:00:00Z" "Add stock reports"

mkdir -p "$repo/.claude-box"
cp "$here/policy.yaml" "$repo/.claude-box/policy.yaml"
printf '.claude-box/\n__pycache__/\nreports/\n' >> "$repo/.git/info/exclude"

echo "$repo"
