# Owner posts and direct messages

The owner can post to one agent of a build, and an agent can message the
owner directly. This page describes how the engine handles both. For the
design, see the "Owner posts" and "Direct messages" sections of
[`design.md`](design.md). For the team chat that carries the messages, see
[`team-chat.md`](team-chat.md).

## Post as the owner

You post through the server API, and the Boxes app uses the same route:

```
POST /api/v1/builds/BUILD_ID/posts
```

Replace `BUILD_ID` with the build's ID. The body takes these fields:

| Field | Meaning |
| :-- | :-- |
| `to` | The seat to post to, such as `developer`. It can't be `owner`. |
| `toTask` | The task of the agent, when several agents fill the seat. |
| `taskId` | The task the post is about. The default is the addressee's task. |
| `milestone` | The milestone the post is about, for a post about no one task. |
| `type` | The message type. The default is `note`. |
| `body` | The text of the post. |

The engine routes the post in one of two ways, and the answer's `route`
field names which:

- **`agent`:** in a build that started, the post goes to the addressed agent
  on the team chat. Only that agent runs: the engine resumes its session, or
  gives the post to the agent that next takes the seat. The answer holds the
  saved `message` and the `decision` that records it.
- **`meeting`:** while a planning meeting runs, a post for its proposer or
  one of its members goes into the meeting. The meeting brings the post to
  every member at its next turn, as `aio-build meeting-post` does. The answer
  holds the `meeting` record.

In planning, a post for a seat that no meeting under way holds fails with
`invalid_state`. A post to a build that ended fails with `invalid_state` too.

## Decisions

The engine records each owner post to an agent as a decision, in the
build's `decisions/DN.json` file. A decision attaches to the post's task, or
to its milestone. Every later prompt for an agent on the task carries the
decision in an "Owner decisions" section, so tests, reviews, and fixes work
from the post and don't undo it.

The agent's turn for an owner post answers with the acceptance criteria that
the post contradicts. When it names any, the engine does two things:

- It sends the Project manager a team chat note that flags the post as a
  change to the build plan.
- It adds a `planChange` flag to the decision, with the criteria, the
  reason, and the ID of that note.

The agent works from the post either way. The Project manager changes the
plan's criteria to match it, or asks the owner.

## Direct messages

An agent sends the owner a direct message with the `send_message` tool and
`to: "owner"`. Each agent, a seat on one task, can send two direct messages
in each milestone. The build plan's `directMessagesPerMilestone` field
changes the limit. The team chat refuses a message past the limit and tells
the agent why, and the agent's work goes on: the build doesn't pause.

The server notifies the owner about each direct message: the Boxes app
raises a desktop notification that names the agent and the build, and a
click on it opens the build view, which lists the build's direct messages.

## Read messages and decisions

The Project manager reads the team chat from its box with the `aio-build`
command:

```bash
aio-build messages SLUG --direct
aio-build decisions SLUG

```

Replace `SLUG` with the build's slug. Without `--direct`, the `messages`
request prints every team chat message of the build. The `decisions` request
prints each decision with its task and any plan change flag. Add `--json` for
the raw records.
