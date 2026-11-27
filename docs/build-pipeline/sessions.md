# Session resume

The engine keeps the session of every agent in a build, with its seat and
its tasks. When a team chat message arrives for an agent whose turn ended,
the engine resumes that agent's session, so the agent doesn't rediscover the
code. For the reasons, see the "Session resume" sections of the
[build pipeline design](design.md). For the messages themselves, see
[Team chat bus](team-chat.md).

## The session registry

The engine records each session in the build's
`.aio/builds/SLUG/sessions.json` file, which survives an engine restart.
Replace `SLUG` with the build's name. The `SessionRegistrySchema` schema in
the `packages/contracts/src/sessions.ts` file defines the file, which holds
the following lists:

- **`sessions`:** every agent session in start order. Each one names its
  seat, the plan tasks it works for, the vendor and its session ID, the
  account folder that holds the session, the placement it runs on, the
  vendor a rule keeps the seat off (for the coverage check), the task brief
  that its agent got, and its turns.
  Each turn records the agent call key, the message it answered, when it
  ended, the build worktree's `HEAD` commit at that time, and its input
  tokens.
- **`queue`:** the messages that wait for a turn, oldest first.
- **`deliveries`:** each message that took a turn, with the session that
  took it, or that failed to, with the reason.

A Developer's session works for its task. The Test engineer's session in
the tests first step works for every task in scope, so a message about any
of those tasks reaches it.

When a build step starts a new agent in a seat, the new session replaces the
seat's earlier session for the same tasks: the earlier record gets
`replacedBy`, and messages go to the new session from then on.

## Delivery

A message to a seat goes to the newest session that holds the seat for the
message's task, or waits for the seat call under way for that task. A
message to the owner, or to a seat and task that no agent holds, isn't a
session's to take, and the registry doesn't queue it.

Each seat takes one turn at a time. A message for an agent whose turn is
under way waits in the queue until the turn ends, and two messages for one
session run as two turns in the order the engine saved them. A build step
ends only after the message turns that it started finish.

Every message turn also waits for the build worktree. The build holds the
worktree through each step, its own agent calls included, and lets go of it
only while it waits for a seat, between steps, and while it waits for an
escalation. So a resumed agent never changes files while the build's agent
works or while the task gate, a red check, or a commit reads them, and
nothing changes the worktree under a read-only turn.

A turn of a seat that writes files may change only what its seat may: its
writable paths for the session's task, and never a locked test. The engine
puts back any other file the turn changed, the way it was before the turn,
and raises an escalation for the Project manager that names the files. The
turn records the paths it kept with the turn, in `changed`. The task gate doesn't count those paths against the
attempts of another seat's task, and a task that a turn's escalation paused
doesn't start its next attempt.

While the build is paused, by a person or by a box stop, a message waits
in the queue and starts no turn, even after an engine restart. A turn that
the pause reaches before its vendor call goes back to the queue. When the
build resumes, the engine delivers each waiting message once. A message
that waits doesn't keep the build from showing `paused (idle)`.

A resumed turn runs in the account folder that holds the session, even when
the vendor's default account folder changed or the engine restarted since.

A resumed turn's prompt holds the message and a summary of the commits that
landed on the build branch since the session's last turn, one `SHA subject`
line for each, oldest first. The agent replies with the `send_message` tool.

When a message turn fails, such as an agent call that fails twice, the
registry records the delivery as `failed` and the engine raises an
escalation for the Project manager. The escalation pauses the message's
task, or the sender's task, when that is a plan task. Otherwise the build
waits for it before its next step.

## When a message gets a fresh agent

The engine starts a fresh agent instead of resuming the session in the
following cases:

- **`size`:** the session's last turn used more input tokens than the
  threshold, and the vendor's prompt cache expired since that turn. A resume
  would reread the whole history at full price.
- **`placement`:** the seat's vendor, model tier, or effort changed since
  the session started, so the session's cache doesn't apply.
- **`no_session`:** the vendor reported no session to resume.

The fresh agent gets the role prompt for the session's task brief, the list
of the task's files to read first, the team chat messages to and from the
seat on its tasks, and the message to act on. The registry records the new
session with the reason, links it to the session it replaces, and marks the
old one as replaced.

## Settings

The threshold and the cache windows are fields of the `sessions` map in the
project's [policy file](../policy.md):

```yaml
version: 1
sessions:
  freshAboveTokens: 100000
  cacheWindowMinutes:
    claude: 60
    codex: 30
    copilot: 5
```

The values shown are the defaults. The Claude and Codex windows come from
the design; a spike measured Codex cache hits on resumes after 45 minutes,
so the Codex default is conservative. Copilot doesn't publish a cache window,
so its default is short.
