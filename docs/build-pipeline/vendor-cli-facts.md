# Vendor CLI facts for the build pipeline

This page records four facts about the vendor CLIs that the build pipeline
design depends on. Each fact comes from a live run against the CLI versions
that the `image/versions.env` file pins: Codex CLI 0.170.0 and Claude Code
2.1.328. The runs took place on 2026-11-23 on a Linux host, with small models
(`gpt-6-luna` at low effort for Codex, Haiku for Claude Code) and a throwaway
working directory.

The Codex runs used a test MCP server: a short Node.js script that speaks
MCP over streamable HTTP on `127.0.0.1`, offers one tool, `bus_ping`, which
returns the marker `BUS-OK-7731`, and logs every request with its
`Authorization` header.

## Summary

The following table lists each question and its answer:

| Question | Answer |
| :-- | :-- |
| Does `codex exec` load an MCP server from a `-c` override? | Yes, on a first run and on a resume. |
| How does Codex approve MCP tool calls without a terminal? | It refuses them unless the server sets `default_tools_approval_mode="approve"`. |
| How long does the Codex prompt cache last? | At least 45 minutes, the longest delay measured. |
| Does a line typed through tmux start a Claude Code turn? | Yes when the session is idle. When it's busy, the line runs as the next turn. When it shows a dialog, the text is lost and `Enter` answers the dialog. |

The team chat bus doesn't need a stdio shim. The HTTP endpoint that the
design describes works for Codex, provided that each Codex call carries the
approval setting.

## Codex MCP server from a configuration override

A `-c mcp_servers.NAME.url=URL` override loads the server for that call. On
a first run, Codex connects, lists the tools, and calls the tool:

```bash
codex exec --json --skip-git-repo-check -m gpt-6-luna \
    -c model_reasoning_effort=low --sandbox read-only \
    -c 'mcp_servers.bus.url="http://127.0.0.1:18731/mcp"' \
    -c 'mcp_servers.bus.default_tools_approval_mode="approve"' \
    "Call the bus_ping tool once, then reply with exactly the text it returned."
```

The server log shows `initialize`, `notifications/initialized`, `tools/list`,
and `tools/call`, and the last `agent_message` event is `BUS-OK-7731`.

A resume with the same override, pointed at a second server on another port,
connects to the second server and calls the tool there. The resume used a
different URL from the first run, so Codex reads the server from the
resume's own configuration, not from the session record:

```bash
codex exec resume --json --skip-git-repo-check -m gpt-6-luna \
    -c model_reasoning_effort=low -c 'sandbox_mode="read-only"' \
    -c 'mcp_servers.bus.url="http://127.0.0.1:18732/mcp"' \
    -c 'mcp_servers.bus.default_tools_approval_mode="approve"' \
    THREAD_ID "Call the bus_ping tool once more and reply with exactly the text it returned."
```

Replace `THREAD_ID` with the `thread_id` value from the first run's
`thread.started` event.

The run also showed the following:

- **No carryover:** a resume without the override doesn't have the tool. Asked
  to call `bus_ping` if it exists, the model replied `NO-TOOL`. The engine
  must attach the server on every resume, as the design says.
- **Per-agent token:** `-c 'mcp_servers.bus.bearer_token_env_var="VAR"'` makes
  Codex send `Authorization: Bearer VALUE` on every request, where `VAR` names
  an environment variable of the Codex process and `VALUE` is its value. The
  engine can give each agent its own token this way, without putting the token
  on the command line.
- **Flag order on resume:** `codex exec resume` rejects `--sandbox` after
  `resume`. Pass `--sandbox` before `resume`, as the engine's Codex adapter
  does, or pass `-c sandbox_mode=...`.

## Codex MCP tool approval without a terminal

`codex exec` runs with the approval policy `never`. Under that policy, Codex
refuses an MCP tool call that needs approval and reports the refusal as a
failed `mcp_tool_call` item:

```json
{"type":"mcp_tool_call","server":"bus","tool":"bus_ping","status":"failed",
 "error":{"message":"MCP tool call requires approval, but approval policy is never"}}
```

The server setting `mcp_servers.NAME.default_tools_approval_mode` decides
which calls need approval. Its values are `auto`, `prompt`, `writes`, and
`approve`. The following table lists the result of each value tested:

| Value | Result of the `bus_ping` call |
| :-- | :-- |
| Not set | Refused |
| `auto` | Refused |
| `writes` | Refused |
| `approve` | Runs and returns `BUS-OK-7731` |

The test tool declared `readOnlyHint: false`. To let bus tools run, pass
`-c 'mcp_servers.NAME.default_tools_approval_mode="approve"'` on every
`codex exec` and `codex exec resume` call.

The runs used the `read-only` sandbox. The engine runs Codex with
`--sandbox danger-full-access` inside the container, a mode that this spike
didn't run. The approval setting is a property of the MCP server, not of the
sandbox, so the engine must pass it in both modes.

## Codex prompt cache lifetime

The Codex prompt cache kept a resumed session's history for at least 45
minutes, the longest delay measured. Longer delays weren't measured.

For each delay, a probe started a session whose first prompt carried about
27,000 tokens of unique random filler, waited the delay with no activity on
that session, and then resumed it with a one-line prompt. The probes for all
delays ran in parallel, so each session's unique history was cached only by
its own first turn. The following table lists the input and cached input
tokens of each turn:

| Delay | First turn input | First turn cached | Resume turn input | Resume turn cached | Resume cache hit |
| :-- | --: | --: | --: | --: | --: |
| 1 minute | 38,693 | 11,392 | 38,710 | 38,528 | 99.5% |
| 5 minutes | 38,811 | 11,392 | 38,828 | 38,656 | 99.6% |
| 10 minutes | 38,664 | 11,392 | 38,681 | 38,528 | 99.6% |
| 20 minutes | 38,725 | 15,104 | 38,742 | 38,528 | 99.4% |
| 30 minutes | 38,794 | 11,392 | 38,811 | 38,656 | 99.6% |
| 45 minutes | 38,733 | 11,392 | 38,750 | 38,528 | 99.4% |

On the first turn, only the shared prefix of about 11,400 tokens (the Codex
system prompt and tools) came from the cache. On every resume, the session's
unique filler came from the cache too. The design's default cache window of
30 minutes for Codex is therefore safe. The 60-, 90-, and 120-minute probes
were stopped before they ran, to keep the spike short.

The probes used this pair of commands:

```bash
codex exec --json --skip-git-repo-check -m gpt-6-luna \
    -c model_reasoning_effort=low --sandbox read-only \
    "Ignore this filler: FILLER

Reply with exactly OK."
codex exec resume --json --skip-git-repo-check -m gpt-6-luna \
    -c model_reasoning_effort=low -c 'sandbox_mode="read-only"' \
    THREAD_ID "Reply with exactly OK2."
```

Replace the following:

- `FILLER`: 6,000 random six-letter words, unique to each probe
- `THREAD_ID`: the `thread_id` value from the first command's
  `thread.started` event

The usage that `codex exec resume --json` reports in its `turn.completed`
event is the total for the whole thread, not for the resumed turn. The
rollout file's `token_count` events confirm it: `last_token_usage` holds the
turn, and `total_token_usage` matches the `turn.completed` event. The table
lists each resume turn as the resume's total minus the first turn. The
engine's Codex adapter adds the `turn.completed` usage of each call, so it
counts a resumed session's earlier turns again.

## Claude Code input through tmux

An interactive Claude Code session ran in a private tmux server. The spike
typed each line with `tmux send-keys -l` and then sent `Enter` in a separate
`send-keys` call. The session transcript confirms each result.

| Session state | Result of a typed line and `Enter` |
| :-- | :-- |
| Idle at the prompt | Starts a turn. |
| Busy with a turn | Queued. The UI shows `Queued`, the transcript records `enqueue` and `dequeue` operations, and the line runs as the next turn after the current one ends. |
| Workspace trust dialog at start | The text is dropped, and `Enter` picks the selected option, `No, exit`, so Claude Code exits. |
| `AskUserQuestion` dialog | The text is dropped, and `Enter` answers with the first option. |
| Tool permission dialog | The text is dropped, and `Enter` picks `Yes`, which approves the pending tool call. |

The run also showed the following delivery details:

- **Enter in the same call:** when the text and `Enter` go in one fast
  `send-keys` call, Claude Code can take the input as a paste and treat
  `Enter` as a newline. One long line stayed in the input box and joined the
  next message. Send `Enter` in a separate call after a short pause.
- **Prompt suggestions:** after a turn ends, Claude Code can show a
  suggested next prompt in the empty input box, drawn dim (SGR 2). A plain
  `tmux capture-pane -p` prints it like typed text, so read the screen with
  `-e` and drop dim text from the prompt line. The transcript confirms that
  the typed line, not the suggestion, arrived.
- **Multiline text:** a newline inside `send-keys -l` text, or inside a
  bracketed paste (`tmux paste-buffer -p`), stays in the input box as a line
  break. The following `Enter` submits the whole message as one turn.

A message typed into a dialog is lost at best, and at worst answers the
dialog: it can exit the session, answer a question for the agent, or approve
a tool call. Before the engine types into a Claude Code session, it must
check that the session shows the input prompt and no dialog, and it must
confirm delivery from the transcript.
