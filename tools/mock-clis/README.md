# Mock vendor CLIs

This package holds stand-ins for the `codex`, `copilot`, and `claude` CLIs.
Each one accepts the flags that the engine's vendor adapters pass, prints
output in the real CLI's shape, and answers from a scenario file instead of a
model. Use them to run the review pipeline end to end where a real CLI is
missing, not signed in, or too costly for a test.

The output shapes follow what the vendor adapters in `packages/engine/src/adapters/`
parse, and the sample output in `packages/engine/test/adapters/fixtures/`.

The scripts need Node.js 22 or later and have no dependencies.

## Put the mocks on PATH

To make every adapter in a shell or container pick up the mocks, put the
`bin` directory first on `PATH`:

```sh
export PATH="/PATH/TO/aio/tools/mock-clis/bin:$PATH"
export MOCK_CLI_SCENARIO=/PATH/TO/scenario.json
codex --version
```

Replace `/PATH/TO/aio` with the repository checkout as the container
sees it, and `/PATH/TO/scenario.json` with your scenario file.

The `claude` stand-in shadows the real Claude CLI on that `PATH`. To mock
only Codex and Copilot, link those two into a directory of their own:

```sh
mkdir -p ~/.local/mock-clis
ln -sf /PATH/TO/aio/tools/mock-clis/bin/codex ~/.local/mock-clis/codex
ln -sf /PATH/TO/aio/tools/mock-clis/bin/copilot ~/.local/mock-clis/copilot
export PATH="$HOME/.local/mock-clis:$PATH"
```

Inside a project container, add the same lines to the shell profile of the
container user, or pass `PATH` and `MOCK_CLI_SCENARIO` as environment
variables when the engine starts. Tests can skip `PATH` entirely and give an
adapter the script's absolute path through its `command` option.

## Environment variables

| Variable | Meaning |
|---|---|
| `MOCK_CLI_SCENARIO` | The scenario file. Without it, every call answers `{"findings":[]}`. |
| `MOCK_CLI_STATE` | Where use counts are kept. Default: the scenario path plus `.state.json`. Delete it to restart a scenario. |
| `MOCK_CLI_LOG` | A file that gets one JSON line per call, with the arguments, prompt, and chosen response. |
| `CODEX_HOME` | When set, the `codex` mock writes a session rollout file under `CODEX_HOME/sessions`, as the real CLI does, with the scenario's `rateLimits` and the thread's token totals. The mock writes it before `delayMs` and before an `error`, so a call that fails or is stopped still leaves its tokens there. A resumed call reports the thread's total tokens on `turn.completed`, as Codex does. Without it, the mock writes nothing, so it never touches your real `~/.codex`. |

## Scenario file

A scenario holds one section per CLI. A section's `responses` list is
searched in order for each call; the first response whose `match` fits the
prompt and whose `times` isn't used up answers it.

```json
{
  "codex": {
    "responses": [
      {
        "match": "Review group G-1",
        "times": 1,
        "output": { "findings": [] },
        "tokens": { "input": 12000, "output": 400 },
        "rateLimits": { "primary": 35, "secondary": 60 }
      },
      { "match": "Review", "error": "usage_limit" }
    ]
  },
  "copilot": {
    "responses": [{ "output": { "findings": [] }, "model": "gemini-3-pro", "premiumRequests": 5.4 }]
  },
  "claude": {
    "responses": [
      { "match": "Fix", "output": { "done": true }, "writeFiles": { "src/a.ts": "export {};\n" } }
    ]
  }
}
```

Each response takes these fields, all optional:

| Field | Meaning |
|---|---|
| `match` | A regular expression tested against the prompt. |
| `times` | How many calls the response answers. Absent means every call. |
| `output` | The JSON answer. Default `{"findings":[]}`. |
| `text` | Raw answer text instead of `output`, such as prose around JSON. |
| `error` | `usage_limit`, `rate_limit`, `auth`, or `crash`. The CLI fails the way the real one does. |
| `errorMessage` | Replaces the error's default text. |
| `exitCode` | Overrides the exit code. |
| `stderr` | Text written to stderr. |
| `delayMs` | Waits this long before answering, to test timeouts. |
| `tokens` | `{ "input": N, "output": N }` for the usage report. |
| `rateLimits` | `{ "primary": PERCENT, "secondary": PERCENT }`: Codex rollout and Claude `rate_limit_event` utilization. |
| `premiumRequests` | Copilot only: the premium requests the call reports. |
| `model` | Copilot only: the model that automatic selection picks. |
| `costUsd` | Claude only: the call's `total_cost_usd`. |
| `sessionId` | The session or thread id to report on a fresh call. |
| `writeFiles` | `{ "relative/path": "content" }` written in the working directory, but only when the call may write: Codex with a writable sandbox, Copilot with `--allow-all-tools`, Claude outside `dontAsk` mode. |
| `commit` | A commit message. After `writeFiles`, the mock commits every change in the working directory with it, as an agent that commits its work does. Needs `writeFiles` and the same write permission. A clean working directory gets no commit. |
| `busCalls` | Claude and Codex only: `[{ "tool": "send_message", "arguments": { ... }, "server": "NAME" }]`, MCP tool calls that the mock makes before it answers. `server` is optional and defaults to the first configured server. |

## MCP tool calls

The `claude` and `codex` mocks act out the MCP tool calls that a response
lists in `busCalls`, the way an agent calls the team chat bus. For each call,
the mock sends `initialize`, `notifications/initialized`, `tools/list`, and
`tools/call` over streamable HTTP, and records each result in the call's
`MOCK_CLI_LOG` line under `busResults` (`server`, `tool`, `isError`, `text`).

The mocks read the servers from the flags that the real CLIs take:

- **`claude`:** `--mcp-config FILE_OR_JSON`, whose `mcpServers` entries give
  each server's `url` and `headers`, and `--strict-mcp-config`. In `dontAsk`
  mode, a call to a tool that `--allowedTools` doesn't list as
  `mcp__SERVER__TOOL` is denied, as the real CLI denies it.
- **`codex`:** `-c mcp_servers.NAME.url="URL"`, and
  `-c mcp_servers.NAME.bearer_token_env_var="VAR"`, which sends the value of
  the environment variable `VAR` as the bearer token. Unless
  `-c mcp_servers.NAME.default_tools_approval_mode="approve"` is set, the
  call fails with the message that `codex exec` gives, `MCP tool call
  requires approval, but approval policy is never`. Each call shows in the
  output as an `mcp_tool_call` item.

The mocks reject flags their real CLI doesn't have, such as
`codex exec --full-auto`, which Codex removed, so an adapter that drifts
from the real flags fails against the mock too.
