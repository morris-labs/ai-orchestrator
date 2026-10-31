#!/usr/bin/env bash
# Installs AppArmor profiles that let this checkout's Electron apps start.
#
# Ubuntu 24.04 and later restrict unprivileged user namespaces, which
# Chromium's sandbox inside Electron needs, and the chrome-sandbox helper
# that pnpm installs isn't owned by root with mode 4755. The .deb solves
# this with the profiles in packaging/deb/apparmor/. This script builds the
# same profiles for the Electron binaries in this checkout's node_modules,
# resolved to their real paths in the pnpm store, writes them to
# /etc/apparmor.d/, and loads them. It runs sudo for those two steps.
#
# Each profile carries a comment that names this checkout. The script
# replaces the profiles it wrote for this checkout before, so a profile for
# an Electron version that pnpm has since replaced doesn't linger, and
# --remove unloads and deletes all of them.
#
# A profile is named after the binary's path, because two profiles that
# attach to one path conflict. Checkouts and worktrees that share a pnpm
# store share that binary, so one profile can carry the comments of several
# checkouts. The script then only adds or removes its own comment, and a
# profile is deleted when no checkout's comment is left.
#
# It runs scripts/ensure-electron.sh first, which downloads a missing
# Electron binary and removes group and other write permission from it, so
# that only your user can replace what the profile trusts.
#
# Environment:
#   AGENTBOX_APPARMOR_DIR  The profile directory. Default: /etc/apparmor.d.
#                          Tests set it to a temporary directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TEMPLATE_DIR="$ROOT/packaging/deb/apparmor"
PROFILE_DIR="${AGENTBOX_APPARMOR_DIR:-/etc/apparmor.d}"
MARK_PREFIX="# agentbox-dev checkout: "
APPS=(boxes review)
MARK="$MARK_PREFIX$ROOT"
MODE=install

usage() {
  cat <<USAGE
Usage: $(basename "$0") [OPTIONS]

Writes and loads AppArmor profiles that let the Electron binaries in
$ROOT/node_modules
create user namespaces, so that the boxes and review apps start from this
checkout on Ubuntu 24.04 and later. Runs sudo to write to $PROFILE_DIR.

Run it again after pnpm installs a different Electron version.

The profiles attach to binaries in the pnpm store, which your user can
write to. Any program your user puts at those paths can create user
namespaces, which is what the apps need and what the profiles allow.

Options:
  --print       Print the profiles instead of installing them.
  --remove      Unload and delete the profiles written for this checkout.
  -h, --help    Show this help.
USAGE
}

while (($#)); do
  case "$1" in
    --print) MODE=print ;;
    --remove) MODE=remove ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

# Prints the real path of the Electron binary that app APP runs.
electron_binary() {
  local app="$1" link pkg rel bin
  link="$ROOT/apps/$app/node_modules/electron"
  [[ -e "$link" ]] ||
    die "$link is missing. Install the workspace first: corepack pnpm install --frozen-lockfile"
  pkg="$(realpath "$link")"
  [[ -f "$pkg/path.txt" ]] ||
    die "$pkg/path.txt is missing, so Electron's download didn't finish. Run: scripts/ensure-electron.sh"
  rel="$(< "$pkg/path.txt")"
  bin="$(realpath "$pkg/dist/$rel")"
  [[ -f "$bin" ]] || die "$bin is missing. Run: scripts/ensure-electron.sh"
  printf '%s\n' "$bin"
}

# Quotes PATH for an AppArmor profile attachment: AppArmor reads glob and
# variable characters even inside quotes, so they're escaped.
apparmor_quote() {
  local path="$1" out="" ch i
  [[ "$path" != *$'\n'* ]] || die "the path contains a newline: $path"
  for ((i = 0; i < ${#path}; i++)); do
    ch="${path:i:1}"
    case "$ch" in
      '\' | '"' | '*' | '?' | '[' | ']' | '{' | '}' | '^') out+="\\$ch" ;;
      *) out+="$ch" ;;
    esac
  done
  printf '"%s"' "$out"
}

# Prints the checkout comments in profile FILE other than this checkout's.
other_marks() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  grep -F -- "$MARK_PREFIX" "$file" | grep -vxF -- "$MARK" || true
}

# Prints the profile NAME for BINARY, built from the .deb profile of app
# APP: the profile line and the local include name the dev profile, and the
# comments say where it came from. The comments of other checkouts that
# already share the profile file stay in it.
profile_text() {
  local app="$1" name="$2" bin="$3" template line deb_name deb_path in_header=1
  template="$TEMPLATE_DIR/agentbox-$app"
  [[ -f "$template" ]] || die "the profile template $template is missing"
  deb_name="agentbox-$app"
  deb_path="/usr/lib/agentbox/$app/agentbox-$app"
  printf '%s\n' "$MARK"
  other_marks "$PROFILE_DIR/$name"
  printf '# Written by scripts/install-dev-apparmor.sh from packaging/deb/apparmor/%s.\n' "$deb_name"
  printf '# To delete it, run that script with --remove.\n#\n'
  while IFS= read -r line || [[ -n "$line" ]]; do
    # The template's own header describes the packaged profile, so it's
    # replaced by the lines above, apart from its explanation.
    if ((in_header)) && [[ "$line" == "# AppArmor profile for"* ]]; then
      printf '# AppArmor profile for the Electron binary of a source checkout.\n'
      continue
    fi
    [[ "$line" == \#* ]] || in_header=0
    if [[ "$line" == "profile $deb_name $deb_path "* ]]; then
      line="profile $name $(apparmor_quote "$bin") ${line#"profile $deb_name $deb_path "}"
    fi
    line="${line//"<local/$deb_name>"/"<local/$name>"}"
    printf '%s\n' "$line"
  done < "$template"
}

# Prints the profile files under PROFILE_DIR that this checkout wrote.
installed_profiles() {
  local file
  for file in "$PROFILE_DIR"/agentbox-dev-*; do
    [[ -f "$file" ]] || continue
    if grep -qxF -- "$MARK" "$file"; then
      printf '%s\n' "$file"
    fi
  done
}

SUDO=()
((EUID == 0)) || SUDO=(sudo)

apparmor_enabled() {
  [[ -d /sys/kernel/security/apparmor ]] && command -v apparmor_parser > /dev/null 2>&1
}

# Takes this checkout's comment out of profile FILE. When no other
# checkout's comment is left, unloads and deletes the file; otherwise the
# file stays loaded for the checkouts that still use it.
remove_profile() {
  local file="$1" rest
  if [[ -n "$(other_marks "$file")" ]]; then
    rest="$(mktemp)"
    grep -vxF -- "$MARK" "$file" > "$rest" || true
    "${SUDO[@]}" install -m 0644 "$rest" "$file"
    rm -f -- "$rest"
    log "Left $file in place for the other checkouts it names"
    return
  fi
  if apparmor_enabled; then
    "${SUDO[@]}" apparmor_parser -R "$file" > /dev/null 2>&1 || true
  fi
  "${SUDO[@]}" rm -f -- "$file"
  log "Removed $file"
}

if [[ "$MODE" == remove ]]; then
  mapfile -t old < <(installed_profiles)
  if ((${#old[@]} == 0)); then
    log "No profiles for $ROOT in $PROFILE_DIR"
    exit 0
  fi
  for file in "${old[@]}"; do
    remove_profile "$file"
  done
  exit 0
fi

# pnpm can leave the Electron package without its binary. Download it, and
# remove group and other write permission from it, before the profiles name
# its path.
"$SCRIPT_DIR/ensure-electron.sh" --root "$ROOT"

# Both apps usually run the same Electron binary from the pnpm store. Two
# profiles that attach to one path conflict, so each binary gets one
# profile, named after a hash of its path.
names=()
apps_for=()
bins=()
for app in "${APPS[@]}"; do
  bin="$(electron_binary "$app")"
  seen=0
  for i in "${!bins[@]}"; do
    if [[ "${bins[i]}" == "$bin" ]]; then
      seen=1
      break
    fi
  done
  ((seen)) && continue
  hash="$(printf '%s' "$bin" | sha256sum)"
  names+=("agentbox-dev-${hash:0:12}")
  apps_for+=("$app")
  bins+=("$bin")
done

if [[ "$MODE" == print ]]; then
  for i in "${!names[@]}"; do
    ((i == 0)) || printf '\n'
    printf '# %s/%s\n' "$PROFILE_DIR" "${names[i]}"
    profile_text "${apps_for[i]}" "${names[i]}" "${bins[i]}"
  done
  exit 0
fi

[[ -d /sys/kernel/security/apparmor ]] ||
  die "AppArmor isn't enabled on this host, so no profile is needed. If the apps fail to start with a sandbox error, see docs/troubleshooting.md."
require_tool apparmor_parser "Install it with: sudo apt install apparmor"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

mapfile -t old < <(installed_profiles)
for file in "${old[@]}"; do
  keep=0
  for name in "${names[@]}"; do
    [[ "$file" == "$PROFILE_DIR/$name" ]] && keep=1
  done
  ((keep)) || remove_profile "$file"
done

for i in "${!names[@]}"; do
  profile_text "${apps_for[i]}" "${names[i]}" "${bins[i]}" > "$tmp/${names[i]}"
  # Parse the profile before it replaces anything, so a bad one never
  # reaches /etc/apparmor.d.
  "${SUDO[@]}" apparmor_parser -Q -K "$tmp/${names[i]}" ||
    die "apparmor_parser rejected the profile for ${bins[i]}"
  "${SUDO[@]}" install -m 0644 "$tmp/${names[i]}" "$PROFILE_DIR/${names[i]}"
  "${SUDO[@]}" apparmor_parser -r -T -W "$PROFILE_DIR/${names[i]}"
  log "Loaded $PROFILE_DIR/${names[i]} for ${bins[i]}"
done
