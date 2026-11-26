# Planning a build

This page describes how the Project manager plans a build with the
`aio-build` command: it calls the planning seats, holds the Critic meeting,
freezes the build plan, and starts the build from the frozen plan. For the design behind it, see
the "Planning" section of [Build pipeline design](design.md).

## Call a planning seat

To ask a planning seat for its answer, write a brief to a file and run the
following command:

```bash
aio-build plan SLUG SEAT BRIEF_FILE [--issue ISSUE]

```

Replace the following:

- `SLUG`: the build's short kebab-case name, such as `cart-total`.
- `SEAT`: the seat to call. The role library ships `analyst` and
  `architect`. Any read-only role works as a planning seat.
- `BRIEF_FILE`: a file with the owner's request in your words, or the
  changes the owner wants to an earlier answer.
- `ISSUE`: the GitHub issue the build starts from, as `OWNER/NAME#NUMBER`
  or as the issue's link. The build plan links back to it.

The engine runs the call under a lease that names the build, the seat, and
the `planning` step, so planning usage counts by seat. The command waits
for the answer, which can take many minutes.

The seats answer as follows:

- The Analyst writes the spec: stories, edge cases, numbered acceptance
  criteria with a verification method for each, a size, a usage estimate,
  and the secrets and services the build needs.
- The Architect writes the design: the architecture, the shared files, the
  milestones, and the task graph. Each task names its specialties, from
  the list of specialties that the engine gives the Architect, and lists
  the contract files that it implements. No task writes only contracts:
  in a medium or large build, the Contracts step writes them, with stubs,
  before tests first; see [Contracts](design.md#contracts).

Each seat hears the issue, the spec and the design so far, and the
specialties a task can name. After both the Analyst and the Architect
answer, the engine drafts the full build plan in
`.aio/builds/SLUG/planning/draft.json`, with the setup, test, type check,
and lint commands from the project's policy file. The engine rewrites the draft
after each answer, unless you edited it: then it keeps your edits and writes
its own draft from the latest answers to `planning/draft.engine.json`.

## Hold the Critic meeting

For a medium or large build, open a meeting on the Architect's design after
the Architect answers. Write a brief to a file and run the following
command:

```bash
aio-build meet SLUG BRIEF_FILE [--members SEATS] [--proposer SEAT] [--rounds N]

```

Replace the following:

- `BRIEF_FILE`: a file with what the meeting must settle, such as "Attack
  the design for the cart total."
- `SEATS`: the seats that reply, separated by commas. The default is
  `critic`.
- `SEAT`: the seat whose latest answer the meeting discusses. The default
  is `architect`.
- `N`: the round cap, from 1 to 10. The default is 3.

Code takes the turns:

1. The proposer's latest answer is the proposal. A proposer that hasn't
   answered yet answers the brief first.
2. Each member replies once per round with a position (`object`,
   `concern`, or `no_objection`), a severity (`major` or `minor`) for each
   point, and the reasons. A reply that breaks this structure goes back to
   the member once, with the errors; a second broken reply fails the
   meeting.
3. While a major objection remains, the proposer revises from the replies.
   The revision is a planning call like any other, so the draft plan
   follows it.
4. The meeting ends as `agreed` when no major objection remains, or as
   `round_cap` at the round cap, with the open objections in its answer and
   in `STATUS.md`. Report the outcome and the open objections to the owner.

The Critic runs on a vendor other than the proposer's: Codex by default,
against the Architect on Claude. When a repository places the Critic on the
proposer's vendor, the engine refuses the meeting before any call.

The command waits until the meeting ends, which can take hours. Run it in
the background. Planning takes no other request for the build while the
meeting runs.

To pass the owner's words to a running meeting, write them to a file and
run the following command:

```bash
aio-build meeting-post SLUG MEETING POST_FILE

```

Replace `MEETING` with the meeting's ID, such as `meeting-1`. Every member
reads the post at its next turn, ahead of every other input.

To end a running meeting early, such as once you froze the plan it
discusses, run the following command:

```bash
aio-build meeting-end SLUG MEETING

```

The engine stops the turn under way and ends the meeting as `ended`, with
the major objections of its last full round, the last round in which every
member replied, as its open objections. The command returns once the
meeting has ended, and planning then takes requests again, such as the
start.

## Freeze the build plan

When the owner approves the plan, ask the owner whether the build can push
its branch and open its pull request, and then run the following command:

```bash
aio-build freeze SLUG [PLAN_FILE] --push ANSWER

```

Replace the following:

- `PLAN_FILE`: the plan to freeze. Leave it out to freeze the draft.
- `ANSWER`: `yes` when the owner allows the push, or `no`.

The engine refuses a freeze without the push answer. It writes each plan
that changed since the last freeze as the next version, in
`.aio/builds/SLUG/plans/vN.json`, and never changes a frozen version. To
change a frozen plan, freeze the changed plan; it becomes the next version.
For a small build, write the plan yourself and freeze it without calling
any seat.

## Start the build

To start the build from its latest frozen plan, run the following command:

```bash
aio-build start SLUG

```

The build keeps the id that its planning calls used. The engine refuses a
start with a plan file that differs from the frozen plan, and refuses
planning requests once the build runs.

## Files

The engine keeps planning's files beside the build's other files in
`.aio/builds/SLUG/`:

| File | Contents |
|---|---|
| `planning.json` | The planning record: the issue, each seat call, each meeting, and each frozen version |
| `planning/SEAT-N.json` | Each seat call's brief, and its answer or error |
| `planning/draft.json` | The plan drafted from the latest spec and design, with your edits |
| `planning/draft.engine.json` | The engine's own draft from the latest spec and design |
| `meetings/meeting-N.json` | Each meeting: its rounds, the replies, the owner posts, and the open objections |
| `messages/MN.json` | Each meeting turn and owner post, as a team chat message |
| `plans/vN.json` | Each frozen version of the build plan, read-only |
| `STATUS.md` | The planning status, until execution rewrites it |
