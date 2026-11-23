# Planning a build

This page describes how the Project manager plans a build with the
`aio-build` command: it calls the planning seats, freezes the build plan,
and starts the build from the frozen plan. For the design behind it, see
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
  the list of specialties that the engine gives the Architect.

Each seat hears the issue, the spec and the design so far, and the
specialties a task can name. After both the Analyst and the Architect
answer, the engine drafts the full build plan in
`.aio/builds/SLUG/planning/draft.json`, with the test, type check, and lint
commands from the project's policy file. The engine rewrites the draft
after each answer.

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
| `planning.json` | The planning record: the issue, each seat call, and each frozen version |
| `planning/SEAT-N.json` | Each seat call's brief, and its answer or error |
| `planning/draft.json` | The plan drafted from the latest spec and design |
| `plans/vN.json` | Each frozen version of the build plan, read-only |
| `STATUS.md` | The planning status, until execution rewrites it |
