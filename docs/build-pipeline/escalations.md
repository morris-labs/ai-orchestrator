# Escalations

An escalation is a decision that a build can't make inside its build plan.
This page describes what escalates, what an escalation pauses, and how the
Project manager resolves one with the `aio-build` command. For the design
behind it, see the "Escalations" section of
[Build pipeline design](design.md).

## What an escalation holds

The engine writes each escalation to a file in the
`.aio/builds/SLUG/escalations/` directory, such as `E1.json`, and lists it
in the build's `STATUS.md` file. Replace `SLUG` with the build's short name.
The file holds the following fields:

- `kind`: the condition, from the list in the next section.
- `level`: who decides, `project_manager` or `owner`.
- `taskId`: the task that escalated, or `null` for a build step.
- `tasks`: the tasks the escalation pauses.
- `runId`: the build's review run, for an escalation about that run.
- `summary` and `details`: what happened, and what the resolver needs, such
  as the last gate report and the attempt and diagnosis files.
- `status`: `open` or `resolved`, and the `resolution` once it's resolved.

## What escalates

| Kind | Condition | Level |
| :--- | :--- | :--- |
| `attempt_cap` | A task fails its task gate on every attempt. The details list the attempt files and the Debugger's diagnosis files. | Project manager |
| `oscillation` | A task breaks an earlier task's test again. | Project manager |
| `agent_call` | An agent call fails twice, a vendor refuses it, or it needs a decision; or a team chat message can't be delivered. | Project manager |
| `placement` | A seat can't be placed, such as a placement that breaks the single-vendor setting. | Project manager |
| `specialty` | A task's specialty pack can't be loaded. | Project manager |
| `preflight` | A test, type check, or lint command of the plan can't run. | Project manager |
| `tests_first` | The Test engineer's tests fail the engine's checks in every round or in the revision after the coverage check, or the plan lists no test paths. | Project manager |
| `review` | The build's review run doesn't report the diff clean. | Project manager |
| `release_ready` | A criterion has no passing locked test, the push or CI loop stops, or the plan has no push answer. | Project manager; owner for the push answer |
| `missing_secret` | The project doesn't give the build a secret that the plan lists, which preflight checks with the secrets broker, or a Developer reports a secret it can't reach. | Owner |
| `missing_service` | A Developer reports an external service that it can't reach. | Owner |
| `question_cap` | An agent asks more questions about a task than the plan's question cap allows. The question goes to the Project manager, and the details hold it. See [Questions](team-chat.md#questions). | Project manager |
| `test_dispute` | A second test dispute about one test, or a third in one task, which the Project manager rules on; or a Test engineer's fix that changes what a criterion means, which the owner decides. For details, see [Test disputes](test-disputes.md). | Project manager; owner for a criterion change |

A Developer never works around a missing secret or service, for example
with a mock that ships. It stops and reports the gap in the `blocked` field
of its answer, and the engine skips the task gate for that attempt.

## What an escalation pauses

An escalation with a task pauses that task and every task that depends on
it. The engine sets the task aside, so the next task starts from a worktree
without its unfinished work, and then runs the tasks that don't depend on
it. The paused task gets its work back when it runs again.

The build waits, with the `waiting_escalation` status, once no task can run.
An escalation without a task, such as a preflight or review escalation,
makes the build wait right away.

A box stop pauses the work that goes on beside an escalation, and it also
pauses a build that waits for one. A resolution of a paused build records
the decision but doesn't resume the build: the box start, or a resume
request, does. A build that an open escalation without a task holds goes
back to waiting when it resumes.

## Resolve an escalation

To resolve an escalation and resume what it paused, run the following
command:

```bash
aio-build resolve SLUG ESCALATION ACTION [OPTIONS]

```

Replace the following:

- `SLUG`: the build's short name, such as `cart-total`.
- `ESCALATION`: the escalation's ID, such as `E1`.
- `ACTION`: one of the following:
  - `retry`: runs the paused work again. A task goes on with its next
    attempt and gets four more. Tests first gets three more rounds.
  - `reorder`: sets the order of the tasks that aren't done, with
    `--order T2,T1`, and then retries. Each task must still come after the
    tasks it depends on.
  - `clarify`: adds the clarification in `--note` to the task's next
    attempt, and then retries. Use it only for what the plan already
    implies.
  - `decide`: answers the decision that the build's review run waits for,
    with `--decision resume`, `--decision resume_waive --waive F-1,F-2`, or
    `--decision cancel`, and then retries.
  - `escalate`: hands the escalation to the owner, with the reason in
    `--note`.

Only the box that started the build can resolve its escalations. The
engine records the resolution in the escalation file and the build state,
and resumes the paused tasks. It refuses a resolution that doesn't
fit the escalation, such as `reorder` for an escalation without a task, and
a second resolution of one escalation.

### Decisions for the owner

A decision that changes the acceptance criteria, the scope, or the
milestones belongs to the owner. Name the parts that a decision changes
with `--changes`, such as `--changes criteria,scope`. When the list names
one of these parts, the engine doesn't resolve the escalation. It marks the
escalation for the owner and records why. A change to `contracts` or
`architecture` stays with the Project manager, after a planning meeting.

An escalation for the owner takes only the owner's decision. Ask the owner,
then relay the answer with `--owner`, for example:

```bash
aio-build resolve cart-total E1 retry --owner --note "The secret is ticked."

```

For a release ready escalation about the push answer, ask the owner whether
the build can push its branch and open its pull request, and then pass
`--push yes` or `--push no` with `--owner`. The engine records the answer in
the build plan.

The engine's API takes the same request at
`POST /api/v1/builds/SLUG/resolve`.
