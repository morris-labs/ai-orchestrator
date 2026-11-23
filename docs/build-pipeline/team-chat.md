# Team chat bus

The team chat is where a build's agents exchange messages. AI Orchestrator
owns it as a message bus in the engine, and agents of every vendor reach it
through an MCP server. For the reasons, see
[ADR 0004](../adr/0004-team-chat-on-a-bus-that-ai-orchestrator-owns.md). For
how the team chat fits into a build, see the [build pipeline design](design.md).

## Messages

Every message is a file in the build's directory:
`.aio/builds/SLUG/messages/ID.json`. The engine numbers the messages of a
build `M1`, `M2`, and so on, in the order that it saves them. The
`MessageSchema` schema in the `packages/contracts/src/messages.ts` file
defines a message, which holds the following fields:

- **`from`:** the sender: a seat with its task, or the owner. For an agent,
  the engine sets the sender from the agent's token.
- **`to`:** the addressee: a seat with its task, or the owner.
- **`routing`:** `addressed` when the sender named the addressee, `by_type`
  when the engine chose it by type, `reply` when it went back to the sender
  of the message it replies to, and `escalated` for a question past the
  question cap, which went to the Project manager.
- **`type`:** one of `question`, `answer`, `test_dispute`, `file_request`,
  `contract_question`, `bug_report`, `handoff`, `meeting_reply`, or `note`.
- **`taskId` and `milestone`:** what the message is about. A message names at
  least one. The task defaults to the sender's task, then to the addressee's.
- **`paths`:** the repository files that the message is about.
- **`body`:** the text, at most 20,000 characters.
- **`replyTo` and `thread`:** for a reply only, the message it replies to
  and the first message of its thread. A message that replies to none
  starts a thread whose ID is its own.

Each saved message also goes out as a `message.sent` event, which the build's
`events.jsonl` file records and the server relays for the builds of the
engine's project.

## Routing

When an agent names an addressee, the message goes to that seat, or to the
owner for `owner`. When it names none, a reply goes to the sender of the
message it replies to, and the engine routes any other message by type:

- **`test_dispute`:** to the `test-engineer` seat of the message's task.
- **`file_request`:** to the seat that works the task whose owned files cover
  the first of `paths` that a task owns. With no such task, the message goes
  to the Project manager. A file request must name its files.
- **`contract_question`:** to the `architect` seat.
- **Any other type:** to the `project-manager` seat.

## Questions

An agent asks with a `question` message. The addressee answers with a
message whose `replyTo` field names the question, so the question and its
answer form one thread in the message files. Without `to`, the answer goes
back to the agent that asked, and the engine delivers it in that agent's
resumed session; see [Sessions](sessions.md). A reply's task and milestone
default to those of the message it replies to. The team chat refuses a
reply to a message ID that the build doesn't have.

Each agent, a seat on one task, can ask five questions about each task.
The build plan's `questionsPerTask` field changes the cap. A question past
the cap doesn't reach its addressee: the team chat saves it addressed to
the Project manager with `escalated` routing and raises a `question_cap`
escalation, whose details hold the question. The escalation pauses the
task when the agent's attempt ends; for how the Project manager resolves
it, see [Escalations](escalations.md). Only messages of type `question`
about a task count against the cap.

## How agents reach the bus

The bus is one MCP endpoint over streamable HTTP in the engine process. It
listens on `127.0.0.1` at a free port, so only processes in the project
container reach it. It answers `initialize`, `ping`, `tools/list`, and
`tools/call` with plain JSON, and it has no sessions and no event stream.

For each seat call, the build context issues a token for the agent's seat and
task, attaches the bus to that call only, and revokes the token when the call
ends. The bus refuses a request without a token it knows with an HTTP
`401 Unauthorized` status code. The `send_message` tool takes no sender
argument and refuses unknown arguments, so an agent can't send as another
seat.

Each vendor adapter attaches the bus as follows, on every call and every
resume:

- **Claude Code:** a `--mcp-config` file, readable only by the engine's user,
  that names the server and sends the token in an `Authorization` header;
  the `--strict-mcp-config` flag; and the bus tools, such as
  `mcp__aio_team__send_message`, in the `--allowedTools` flag.
- **Codex:** `-c` overrides for `mcp_servers.aio_team.url`,
  `mcp_servers.aio_team.bearer_token_env_var="AIO_TEAM_TOKEN"`, and
  `mcp_servers.aio_team.default_tools_approval_mode="approve"`. The token
  travels in the `AIO_TEAM_TOKEN` environment variable of the Codex process.

The token never appears on a command line. A process that the agent starts
can still read it as the same user, as with every other credential in the
container.

For the evidence behind the Codex settings, see
[Vendor CLI facts for the build pipeline](vendor-cli-facts.md).

## Engine API

The `packages/engine/src/team/` directory holds the bus. The engine starts
one `TeamBus` object in `startEngine()` and passes it to the build manager.
The following example shows the calls that a build makes:

```ts
const bus = new TeamBus({ log });
await bus.start();
const channel = bus.channel({ buildId, dir, tasks: () => plan.tasks, emit });
const pass = channel.admit({ seat: "developer", taskId: "T1" });
try {
  await calls.call({ ...spec, request: { ...spec.request, team: pass.attachment } });
} finally {
  pass.revoke();
}
```

The `TeamChannel` object of a build offers the following methods:

- **`admit(member)`:** issues a token for one agent call and returns its
  attachment and a `revoke()` function.
- **`send(from, input)`:** routes, saves, and announces a message. The
  `send_message` tool calls it with the sender from the token. The engine
  can call it with `{ kind: "owner" }` for an owner post. It throws a
  `MessageRefused` error for input that isn't a valid message.
- **`list()`:** returns every saved message of the build, oldest first.
- **`onMessage(listener)`:** calls the listener with each message saved from
  then on, and returns a function that stops it. Delivery to an addressee and
  the Project manager's digests can build on it.
- **`close()`:** revokes every token of the build.

The channel's `check` option checks each message before the channel saves
it, and can return a changed message to save instead. The build uses it
for the direct message limit, see [`owner-posts.md`](owner-posts.md), and
for the question cap, which routes a question past the cap to the Project
manager.

The `BuildContext.team` property holds the channel of a build, or `null` when
the engine runs no bus.
