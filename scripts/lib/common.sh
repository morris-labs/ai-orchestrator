# shellcheck shell=bash
# Shared helpers for the AI Orchestrator build scripts. Source this file; don't
# run it.
#
# The scripts that source it set `set -euo pipefail` themselves.

# Prints an error message to stderr and exits with status 1.
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Prints a progress message to stderr.
log() {
  printf '==> %s\n' "$*" >&2
}

# Exits with a clear message when the command NAME isn't on PATH.
# HINT tells the reader how to install it.
require_tool() {
  local name="$1" hint="$2"
  command -v "$name" > /dev/null 2>&1 || die "$name is not installed. $hint"
}

# Prints the command that runs pnpm: `pnpm` when it's on PATH, otherwise
# `corepack pnpm`. Exits when neither is available.
pnpm_cmd() {
  if command -v pnpm > /dev/null 2>&1; then
    echo pnpm
  elif command -v corepack > /dev/null 2>&1; then
    echo "corepack pnpm"
  else
    die "pnpm is not installed. Install Node.js 22, then run: corepack enable"
  fi
}

# Prints the KEY=VALUE lines of a versions file, without comments or blank
# lines. Exits when a line isn't a plain KEY=VALUE pair.
read_versions() {
  local file="$1" line
  [[ -f "$file" ]] || die "versions file not found: $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^[A-Z][A-Z0-9_]*=[^[:space:]\"\']+$ ]] ||
      die "$file: expected KEY=VALUE without quotes or spaces, got: $line"
    printf '%s\n' "$line"
  done < "$file"
}

# Prints the value of KEY from a versions file. Exits when KEY is missing.
version_of() {
  local file="$1" key="$2" value
  value="$(read_versions "$file" | sed -n "s/^${key}=//p")"
  [[ -n "$value" ]] || die "$file has no $key"
  printf '%s\n' "$value"
}

# Runs the sed EXPRESSION on FILE in place. GNU sed takes `-i` alone and
# BSD sed (macOS) needs a suffix argument, so this writes a backup with
# `-i.bak`, which both accept, and removes it.
sed_inplace() {
  local expression="$1" file="$2"
  sed -i.bak "$expression" "$file" && rm -f -- "$file.bak"
}

# Replaces the value of KEY in the versions file FILE. Exits when FILE has no
# KEY line.
set_pin() {
  local file="$1" key="$2" value="$3"
  grep -q "^${key}=" "$file" || die "$file has no $key line"
  sed_inplace "s|^${key}=.*|${key}=${value}|" "$file"
  log "$key=$value"
}

# Prints the latest version of the npm package PKG. Exits when npm can't
# resolve it.
npm_latest() {
  local pkg="$1" v
  v="$(npm view "$pkg" version 2> /dev/null)" || die "npm view $pkg failed; check your network and the npm registry"
  [[ -n "$v" ]] || die "npm returned no version for $pkg"
  printf '%s\n' "$v"
}
