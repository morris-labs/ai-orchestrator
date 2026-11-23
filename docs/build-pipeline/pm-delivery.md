# Delivery to the Project manager

The Project manager is the main session of the box that runs a build. The
engine tells it about each escalation and each digest with a one-line
pointer to a file, typed into the session. The Project manager gets digests
that code builds, not the team chat's raw messages. This page describes the
inbox that holds those items, the digests, and how the server types the
pointers. For the design, see the "Boxes and lifecycle" section of
[`design.md`](design.md).

## The inbox

Each build keeps an inbox in its `.aio/builds/SLUG/inbox.json` file, so the
inbox survives an engine restart. The engine adds one item for each of these:

| Item | Ref | File | Needs an answer |
| :-- | :-- | :-- | :-- |
| An escalation | `E1`, `E2`, and so on | `escalations/ID.json` | Yes |
| A milestone digest | `milestone-ID` | `digests/milestone-ID.md` | No |
| The release ready digest | `release-ready` | `digests/release-ready.md` | No |

A build has at most one item for each kind and ref. An escalation that the
question cap raises (`question_cap`) is an escalation like any other: its
file holds the question that went past the cap.

An item waits until its pointer reaches the session and, for an escalation,
until the escalation is resolved. To list what waits, run the following
command in the box:

```bash
aio-build inbox SLUG

```

Replace `SLUG` with the build's slug. Add `--all` to list every item, and
`--json` for JSON. The server API has the same request, which the Boxes app
can use:

```
GET /api/v1/builds/BUILD_ID/inbox?all=true
```

Replace `BUILD_ID` with the build's ID.

## The pointer

Each pointer is one line that starts with a marker naming the build and the
item, then the item's summary and the file to read:

```
[aio-build cart-total I1] Escalation E1 (attempt_cap, for the project manager): Task T1 failed 4 attempts. Read /work/shop/.aio/builds/cart-total/escalations/E1.json
```

The marker is unique, so the session's transcript shows whether a pointer
reached the session already.

## Milestone digests

When every task of a milestone passes the task gate, the engine writes the
milestone's digest from the build's files and adds it to the inbox. A digest
holds these sections:

- **Tasks:** each task's status, attempts, and commit.
- **Usage:** what the build's settled agent calls spent, by seat, since the
  previous milestone's digest, or since the build started for the first
  milestone. A `project-manager (tokens only)` row shows what the Project
  manager's own session spent; see "The Project manager's usage".
- **Escalations:** the escalations about the milestone's tasks, and the ones
  without a task that the milestone raised.
- **Plan change flags:** owner posts about the milestone that an agent found
  to contradict the acceptance criteria.
- **Team chat:** how many messages the milestone took, by type.

The engine runs the tasks of every milestone in one tasks step, so a
milestone ends when its last task passes. A build plan without milestones
has one, `all`, that holds every task.

## The Project manager's usage

The Project manager's session makes no engine calls, so no lease settlement
records what it spends. Instead, at each digest, the engine reads the token
counts from the session's Claude Code transcripts:

- Each `aio-build` request names the Claude Code session that runs it, from
  the `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CONFIG_DIR` variables that Claude
  Code sets in its shells. The engine records each session of the build's
  own box in the build's `.aio/builds/SLUG/pm-sessions.json` file. A session
  that a resume, a fork, or `/clear` started counts once its first
  `aio-build` request names it.
- Only turns after the build's planning started count: from the planning
  record's creation, or from the build's start for a build that started
  from a plan that the Project manager wrote.
- Each model response counts once, by its message ID, across every
  transcript the engine reads. A resumed session that copies earlier turns
  into its own transcript, and a compaction, don't count a turn twice.

A milestone digest shows the session's turns and tokens since the previous
digest, or since planning started for the first one. The release ready
digest shows the total since planning started. The engine also sends the
total in a `build.seat.usage` event, and the usage by seat lists it as the
`project-manager` row marked tokens only: its calls count the session's
turns, it has no cost estimate, and the build's total leaves it out.

## How the server types a pointer

The server types each pointer into the session of the build's box when all
of these hold:

- The box runs. A stopped box leaves its items waiting, without an error, and
  its start delivers them.
- The session runs Claude Code. The server can't read the screen of another
  vendor's session, so an item for one waits.
- The session shows Claude Code's input box, and the box is empty. A session
  that shows a dialog, or that holds text that nobody sent, waits. Typing
  into a dialog drops the text, and the Enter after it answers the dialog,
  even approving a tool call; see
  [`vendor-cli-facts.md`](vendor-cli-facts.md).

A busy session that shows its input box takes the pointer: Claude Code
queues it as the next turn. The server types the text, waits, and sends
Enter in a separate call. The item counts as delivered once the session's
transcript shows its marker. When the transcript holds the marker already,
the server marks the item delivered without typing it again.

The server tries again when a box starts, when the server starts, and once
a minute for items that wait. Usage watcher alerts take the same path, and
an alert for a stopped box waits in the server's memory until the box
starts.

The `boxes.message` request, and the messages that the server sends when a
review run holds or releases a box's edits, use the same checks: a Claude
Code session that shows a dialog or holds unsent text refuses the message
with `conflict`. The server can't read a Codex or GitHub Copilot session's
screen, so it types nothing into one: `boxes.message` refuses it with
`conflict`, and pointers and usage alerts for it don't go out.

The hold and release edits messages wait while the session can't take
them: the server tries again every five seconds, for up to 30 minutes. When
a run ends before its hold message reached the session, the server sends
neither message.
