# Engine smoke test

The smoke test starts the built engine as the keeper does, with mock vendors,
and drives one read-only review of the sample repository through the engine's
HTTP API with `curl`. It checks that the API, the event stream, the lease
protocol, the run manager, the engine core, and the adapter bridge work
together in one process.

The test uses the following files in this directory:

- `smoke.sh`: builds the sample repository, starts the engine and the lease
  granter, runs the review, prints each command and its answer, and stops the
  engine with `SIGTERM`.
- `lease-granter.mjs`: subscribes to the engine's event stream and grants
  every lease request, in place of the server. The engine waits for a
  subscribed server before each model call, and `curl` can't answer lease
  frames.
- `mock-script.json`: the mock vendor responses. A Codex reviewer reports two
  findings in the `shop/pricing.py` file: a real one that names its symbol and
  a false positive. Every disprover confirms the real finding; the built-in
  default disproves the other one.

## Run the smoke test

To run the smoke test, you need Node.js 22, `curl`, `jq`, and a built
workspace:

```sh
corepack pnpm -r build
packages/engine/test/smoke/smoke.sh SMOKE_DIR
```

Replace `SMOKE_DIR` with an empty or missing directory for the sample
repository, the state directory, and the logs. `SMOKE_DIR` is optional:
without it, the script makes a new temporary directory and prints its path
first. Run `smoke.sh --help` for the usage line.

The script generates a random engine token and never prints it. The token
goes only into two files with mode `0600`: the engine's token file,
`SMOKE_DIR/state/engine.token`, and a header file that `curl` reads with
`-H @FILE`, so it appears in no environment and no command line. The engine
runs with the following environment:

```sh
AGENTBOX_ENGINE_TOKEN_FILE=SMOKE_DIR/state/engine.token
AGENTBOX_ENGINE_PORT=20499
AGENTBOX_PROJECT_ROOT=SMOKE_DIR/sample/repo
AGENTBOX_CONTAINER=claude-agent-proj-sample
AGENTBOX_ENGINE_VERSION=4.0.0-dev
AGENTBOX_STATE_DIR=SMOKE_DIR/state
AGENTBOX_MOCK_VENDORS=1
AGENTBOX_MOCK_SCRIPT=packages/engine/test/smoke/mock-script.json
```

## Transcript

The following transcript is from the C2 engine integration on October 28,
2026, on branch `claude/v4-int-engine`. `$S` stands for `SMOKE_DIR`, `$B` for
`http://127.0.0.1:20499/api/v1`, and `$H` for the bearer token header (in
that run, the header itself; the script now passes `@` and the header file):

```text
$ tools/sample-repo/build.sh "$S/sample"
$S/sample/repo
$ node packages/engine/dist/main.js &
$ curl -s $B/health
{"version":"4.0.0-dev","uptimeS":0.066,"engineVersion":"4.0.0-dev","container":"claude-agent-proj-sample","projectRoot":"$S/sample/repo","streamId":"75fd65df-056a-4fdf-84cd-51de7bb26969","versionMatches":true}
$ node packages/engine/test/smoke/lease-granter.mjs 20499 &
$ curl -s -X POST $B/runs -H "$H" -d {runId, projectId, repoPath, base, readOnly}
{"id":"01JBSM0KE0000000000000000A","status":"running","stage":"preflight","roles":{"reviewer":["codex","copilot"],"disprover":"codex","confirmer":"codex","fixer":"claude"}}
$ curl -s $B/runs/$RUN   (polled every 0.5 s)
poll 1: {"status":"running","stage":"preflight","round":0,"stopReason":null}
poll 2: {"status":"finished","stage":"done","round":3,"stopReason":"clean"}
$ curl -s $B/runs/$RUN/findings
{"id":"F-0001","verdict":"confirmed","severity":"P2","file":"shop/pricing.py","lines":[28,30],"symbol":"average_price","title":"average_price divides by zero for an empty list","reportedBy":"codex-mock-codex","verification":"code-reading"}
{"id":"F-0002","verdict":"disproved","severity":"P2","file":"shop/pricing.py","lines":[9,13],"symbol":null,"title":"apply_discount accepts a discount above 100 percent","reportedBy":"codex-mock-codex","verification":"code-reading"}
$ curl -s "$B/runs/$RUN/findings?verdict=confirmed"
["F-0001"]
$ curl -s $B/runs/$RUN/findings/F-0001
{"id":"F-0001","diffLines":26,"fixDiff":null}
$ curl -s $B/runs/$RUN/rounds
{"round":1,"fixed":0,"costUsd":0,"perVendor":{"codex":{"raised":2,"confirmed":1,"disproved":1,"tokensIn":1200,"premiumRequests":0},"copilot":{"raised":0,"confirmed":0,"disproved":0,"tokensIn":0,"premiumRequests":1}}}
{"round":2,"fixed":0,"costUsd":0,"perVendor":{"copilot":{"raised":0,"confirmed":0,"disproved":0,"tokensIn":0,"premiumRequests":0},"codex":{"raised":0,"confirmed":0,"disproved":0,"tokensIn":0,"premiumRequests":0}}}
{"round":3,"fixed":0,"costUsd":0,"perVendor":{"copilot":{"raised":0,"confirmed":0,"disproved":0,"tokensIn":0,"premiumRequests":0},"codex":{"raised":0,"confirmed":0,"disproved":0,"tokensIn":0,"premiumRequests":0}}}
$ curl -s $B/usage/samples
{"vendor":"codex","account":"user@example.com","window":"5h","utilization":0.25,"spendUsd":null,"ceiling":{"kind":"utilization","window":"5h","max":0.7},"resetAt":"2026-10-28T12:00:00Z","sampleSource":"codex_session","time":"2026-10-28T06:53:28.109Z"}
$ cat $S/state/active-runs
0
$ kill -TERM $ENGINE
engine exit code 0
--- engine log (messages)
warn Vendor calls answer from mock scripts
info The engine is listening
info Event subscriber connected
info Started a run
info Received a signal
info The engine is shutting down
info Event subscriber disconnected
info The engine stopped
--- granter log (counts)
     39 lease.settled
     39 granted (lease)
     39 agent.started
     39 agent.finished
     15 handoff
     14 stage.changed
      4 finding.changed
      3 run.changed running sweep
      3 run.changed running find
      1 usage.sample
      1 run.changed running preflight
      1 run.changed pending preflight
      1 run.changed finished done
      1 hello
```

The run shows the following results:

- The run finishes clean in three rounds, and the `active-runs` file returns
  to `0`.
- The confirmed finding keeps the reviewer's `symbol`, and the false positive
  is disproved.
- The usage sample keeps `sampleSource: codex_session`, and its event
  `source` is the engine's stream.
- Each of the 39 leases gets exactly one `lease.settled` event, because the
  core emits it and the broker doesn't.
- The engine closes the event socket and exits with code 0 on `SIGTERM`.
