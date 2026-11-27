# Triage escalations and digests

Read this when an `[aio-build SLUG ID]` pointer arrives or `aio-build inbox
SLUG` lists a waiting item. Each item names a file; read it first.

## Escalations

An escalation file (`escalations/EN.json`) holds `kind`, `level`, `taskId`,
`tasks` (what it paused), `summary`, `details`, and `status`. The `level`
decides who answers.

### Level `project_manager`: you decide inside the plan

Resolve anything the frozen plan already covers, with
`aio-build resolve SLUG EN ACTION`:

| Situation | Action |
|---|---|
| A transient failure: `agent_call`, a flaky `preflight` command, an `attempt_cap` whose diagnosis files show the next attempt can pass | `retry` |
| A task needs work from a task that hasn't run yet | `reorder --order T2,T1` |
| The agents misread something the plan implies, a `question_cap` whose answer the plan holds, or a test dispute you rule on | `clarify --note "THE ANSWER"` |
| A test dispute where the locked test stays as it is | `retry` |
| A task needs a file that the plan left out of its owned files, such as a gate that put back its changes to a file no unfinished task owns | `retry --own FILE,FILE` or `clarify --note "WHY" --own FILE` |
| The build's review run waits for a decision (`review`) | `decide --decision resume`, `resume_waive --waive F-1,F-2`, or `cancel` |
| The answer changes the acceptance criteria, the scope, or the milestones | ask the owner first; then `retry --owner --changes criteria,scope` with their answer |
| Anything you can't answer from the plan | `escalate --note "WHY"`, then ask the owner |

When the engine itself raised the escalation, the cause is an engine
defect: see the next section.

For `attempt_cap` and `oscillation`, read the attempt and diagnosis files
that `details` lists before you choose; a third identical failure needs a
clarification or the owner, not another retry. A change to contracts or
architecture is yours only after a planning meeting on it.

### Engine defects: pause, write the note, don't fix

An engine defect is a fault in AI Orchestrator, not in the task: for
example, the gate reads the wrong output, a step loses a file, a resolution
the docs allow is refused, or the build stalls with nothing running. Don't
fix, patch, or debug the engine in this session; that work belongs to a
separate session. Resolve with the action the build needs once the engine
is fixed, name the cause, and describe the defect:

```bash
aio-build resolve SLUG EN retry --engine-defect --note "WHAT IS WRONG, WHERE, AND THE EVIDENCE"

```

The engine writes the engine defect note to `engine-defects/EN.md` in the
build directory, names it in `STATUS.md`, and pauses the build. Tell the
owner the note's full path and that a separate session must fix the
engine. Resume with `aio-build resume SLUG` only when the owner says the
fix is installed; the resolution then runs, and the build continues.

### Level `owner`: the owner decides

`missing_secret`, `missing_service`, a test fix that changes what a
criterion means, the push answer of `release_ready`, and every escalation
you handed up. Tell the owner the summary and the choice in plain words,
then relay the owner's answer word for word:

- `aio-build resolve SLUG EN retry --owner --note "THE OWNER'S ANSWER"`
- Accept a criterion change: add `--changes criteria`.
- Push answer: `aio-build resolve SLUG EN retry --owner --push yes|no`.

A missing secret or service gets fixed by the owner, never worked around:
name the secret, and point the owner to the box's **Secrets (project)**
section.

The triage is done when `aio-build inbox SLUG` lists no escalation that
waits for your answer, and the owner knows about each one that waits for
theirs.

## Digests

- **Milestone digest** (`digests/milestone-ID.md`): tell the owner in a few
  lines which milestone finished, the tasks and their attempts, the usage
  by seat, and any escalation or plan change flag. Ask whether to continue
  only when the owner asked to pause after milestones.
- **Hand-off** (`handoffs/milestone-ID.md`): the state that a fresh
  session starts from. Follow "The hand-off at each milestone" in the
  `SKILL.md` file.
- **Release ready** (`digests/release-ready.md`): tell the owner the branch,
  the pull request if the build opened one, and the owner checks it lists.
  The build never merges.

## Other messages

- **Usage alert:** a line that starts with `Usage alert:`. Tell the owner,
  and pause the build only when the owner says so.
- **Plan change flag:** `aio-build decisions SLUG` shows owner posts that
  contradict the criteria. Ask the owner whether to change the criteria or
  withdraw the post.
