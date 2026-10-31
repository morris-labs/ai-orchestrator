#!/usr/bin/env bash
# Runs the engine smoke test: a read-only review of the sample repository with
# mock vendors, driven through the engine API with curl. See README.md.
#
# Usage: smoke.sh [DIR]
# DIR must not exist yet or must be empty; it receives the sample repository,
# the state directory, and the logs. Without DIR, the script makes a new
# temporary directory and prints its path. The script never removes the
# directory, so the logs stay for reading; remove it when you're done. Needs
# node, curl, jq, and a built engine (`corepack pnpm -r build`).
# The echo lines print each command as written, so their single quotes are deliberate.
# shellcheck disable=SC2016
set -euo pipefail
case "${1:-}" in
  -h | --help)
    echo "Usage: $0 [DIR]"
    echo "Runs the engine smoke test in DIR, or in a new temporary directory."
    exit 0
    ;;
esac
if [[ $# -gt 1 ]] || [[ $# -eq 1 && -z $1 ]]; then
  echo "Usage: $0 [DIR]" >&2
  exit 2
fi
# Everything the script creates, DIR included, is for this user only.
umask 077
if [[ $# -eq 1 ]]; then
  DIR="$1"
  if [[ -e $DIR && ! -d $DIR ]]; then
    echo "$DIR exists and isn't a directory." >&2
    exit 2
  fi
  if [[ -d $DIR && -n "$(ls -A "$DIR")" ]]; then
    echo "$DIR isn't empty. Give a new or empty directory." >&2
    exit 2
  fi
else
  DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentbox-smoke-XXXXXX")"
fi
S="$(mkdir -p "$DIR" && cd "$DIR" && pwd)"
echo "Smoke directory: $S"
mkdir -p "$S/state"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
echo '$ tools/sample-repo/build.sh "$S/sample"'
tools/sample-repo/build.sh "$S/sample"
R="$S/sample/repo"
# The token lives only in two 0600 files: the engine's token file and a curl
# header file. It never reaches an environment or a command line.
TOKEN_FILE="$S/state/engine.token"
head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$TOKEN_FILE"
printf 'authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")" > "$S/auth.header"
H="@$S/auth.header"
echo '$ node packages/engine/dist/main.js &'
AGENTBOX_ENGINE_TOKEN_FILE="$TOKEN_FILE" AGENTBOX_ENGINE_PORT=20499 AGENTBOX_PROJECT_ROOT="$R" \
  AGENTBOX_CONTAINER=claude-agent-proj-sample AGENTBOX_ENGINE_VERSION=4.0.0-dev \
  AGENTBOX_STATE_DIR="$S/state" AGENTBOX_MOCK_VENDORS=1 \
  AGENTBOX_MOCK_SCRIPT="$ROOT/packages/engine/test/smoke/mock-script.json" \
  node packages/engine/dist/main.js > "$S/engine.log" 2>&1 &
ENGINE=$!
B=http://127.0.0.1:20499/api/v1
for _ in $(seq 50); do curl -sf "$B/health" >/dev/null && break; sleep 0.2; done
echo '$ curl -s $B/health'
curl -s "$B/health"; echo
echo '$ node packages/engine/test/smoke/lease-granter.mjs 20499 "$TOKEN_FILE" &'
(cd packages/engine && node test/smoke/lease-granter.mjs 20499 "$TOKEN_FILE" > "$S/granter.log" 2>&1) &
sleep 0.5
RUN=01JBSM0KE0000000000000000A
echo '$ curl -s -X POST $B/runs -H "$H" -d {runId, projectId, repoPath, base, readOnly}'
curl -s -X POST "$B/runs" -H "$H" -H 'content-type: application/json' \
  -d "{\"runId\":\"$RUN\",\"projectId\":\"sample\",\"repoPath\":\"$R\",\"base\":\"origin/main\",\"readOnly\":true}" |
  jq -c '{id, status, stage, roles}'
echo '$ curl -s $B/runs/$RUN   (polled every 0.5 s)'
for i in $(seq 120); do
  st="$(curl -s "$B/runs/$RUN" -H "$H" | jq -c '{status, stage, round, stopReason}')"
  echo "poll $i: $st"
  case "$st" in *'"running"'*|*'"pending"'*) sleep 0.5 ;; *) break ;; esac
done
echo '$ curl -s $B/runs/$RUN/findings'
curl -s "$B/runs/$RUN/findings" -H "$H" |
  jq -c '.findings[] | {id, verdict, severity, file, lines, symbol, title, reportedBy, verification}'
echo '$ curl -s "$B/runs/$RUN/findings?verdict=confirmed"'
curl -s "$B/runs/$RUN/findings?verdict=confirmed" -H "$H" | jq -c '[.findings[].id]'
echo '$ curl -s $B/runs/$RUN/findings/F-0001'
curl -s "$B/runs/$RUN/findings/F-0001" -H "$H" | jq -c '{id: .finding.id, diffLines: (.diff | split("\n") | length), fixDiff}'
echo '$ curl -s $B/runs/$RUN/rounds'
curl -s "$B/runs/$RUN/rounds" -H "$H" | jq -c '.rounds[] | {round, fixed, costUsd, perVendor: (.perVendor | map_values({raised, confirmed, disproved, tokensIn, premiumRequests}))}'
echo '$ curl -s $B/usage/samples'
curl -s "$B/usage/samples" -H "$H" | jq -c '.samples[]'
echo '$ cat $S/state/active-runs'
cat "$S/state/active-runs"
echo '$ kill -TERM $ENGINE'
kill -TERM "$ENGINE"
wait "$ENGINE" && echo "engine exit code 0" || echo "engine exit code $?"
wait || true
echo '--- engine log (messages)'
jq -r '"\(.level) \(.msg)"' "$S/engine.log"
echo '--- granter log (counts)'
sed -E 's/^granted .*/granted (lease)/' "$S/granter.log" | sort | uniq -c | sort -rn
echo "The smoke directory $S is kept; remove it when you're done."
