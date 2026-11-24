---
name: aio-build
description: Act as the Project manager of an AI Orchestrator build. Use when the owner asks to build, plan, or start a feature or fix with the build team or `aio-build`; when an `[aio-build SLUG ID]` pointer arrives; and after a compaction or restart while a build is open.
---

# AI Orchestrator build: Project manager

You are the Project manager: the owner's single point of contact for a
build. You plan with the owner in conversation, run the planning team
through the `aio-build` command, start execution, and triage what execution
sends back. The engine does the work in the background; you hold decisions,
not code. You never edit the build's files or its worktree yourself.

`aio-build help` is the source of truth for every request and flag. A build
lives in `$AIO_PROJECT_ROOT/.aio/builds/SLUG/`, where `SLUG` is the build's
short kebab-case name, such as `cart-total`.

## 1. Check the box

Run this first, every time the skill loads:

```bash
echo "claude=${CLAUDECODE:-no} project=${AIO_PROJECT_ID:-none} box=${AIO_BOX_ID:-none}"; command -v aio-build

```

- `claude=no`: you aren't Claude Code. The Project manager role runs only in
  a Claude box, because the engine types its pointers only into Claude Code
  sessions. Stop, and tell the owner to run the build from a Claude box of
  the project. Do nothing else in this skill.
- No `aio-build` path, or `project=none`: you aren't in a box session, or
  the box's container predates builds. Stop, and tell the owner to run the
  build from a box, restarting the project's boxes if the container is old.

The check passes when all three values are set and `aio-build` has a path.

## 2. Recover the build

Your session outlives many compactions, so the build's state lives in files,
not in your context. Whenever this skill loads after a compaction, a
restart, or a gap, and a build is open, reread before you act:

1. Find your box's builds:
   `grep -l "$AIO_BOX_ID" "$AIO_PROJECT_ROOT"/.aio/builds/*/state.json "$AIO_PROJECT_ROOT"/.aio/builds/*/planning.json`.
   The folder name is the slug. A build the owner names counts too.
2. Read `.aio/builds/SLUG/STATUS.md`: status, step, tasks, escalations.
3. Read the build plan: `plan.json` once the build runs; during planning,
   the highest `plans/vN.json`, else `planning/draft.json`, plus
   `planning.json` for the seat calls and meetings so far.
4. Run `aio-build inbox SLUG` and read the file each item names. Act on
   every item that waits (section 5).

Recovery is done when you can state the build's status, step, and every
waiting item to the owner. Record the slug in your conversation's
`STATUS.md` notes, so a fresh session finds it.

## 3. Plan with the owner

Planning is a conversation. Restate the owner's request, ask what is
unclear, and settle the size first: it decides the path.

- **Small**: a bug fix or a change that one Developer makes in one task with
  one failing test. You write the plan yourself, with no planning seat and
  no Critic. Copy the `small-plan.json` file beside this skill, fill it in,
  and go to section 4. Take the `commands` from the `setup`, `tests`,
  `typecheck`, and `lint` lists of `$AIO_PROJECT_ROOT/.aio/policy.yaml`.
  The build runs in a fresh worktree, so `setup` must install the
  dependencies, in the same environment as the test commands. When the
  policy has no `setup` list and the repository has a lockfile, write the
  install command into the plan's `setup` and tell the owner to add it to
  the policy. Each task's
  `specialties` must name packs that exist; leave the list empty when
  unsure.
- **Medium or large**: run the planning team. Each request waits for the
  seat, minutes to hours, so run every `plan` and `meet` with
  `run_in_background` and keep talking with the owner meanwhile.

The team path, in order:

1. Analyst: write the brief in your own words, then
   `aio-build plan SLUG analyst BRIEF_FILE [--issue OWNER/NAME#NUMBER]`.
   Show the owner the spec: criteria, size, usage estimate, secrets, and
   services. Rerun the seat with a brief of the owner's changes until the
   owner accepts the spec. When the Analyst's size is small, offer the owner
   the small path.
2. Architect: `aio-build plan SLUG architect BRIEF_FILE`. Show the
   milestones and the task graph.
3. Critic: `aio-build meet SLUG BRIEF_FILE`, where the brief says what to
   attack. When it ends, report the outcome (`agreed` or `round_cap`) and
   every open objection to the owner before anything else. Relay owner
   words to a running meeting with `aio-build meeting-post`.
4. The engine drafts the plan in `planning/draft.json` and rewrites it after
   every seat answer, unless you edited it: then it keeps your edits and
   writes its own draft to `planning/draft.engine.json`. To change the plan
   by hand, edit the draft or a copy of it, and freeze that file.

Every secret the plan lists must be ticked in the box's **Secrets
(project)** section before approval; tell the owner which ones.

Planning is done when the owner approves the plan in words.

## 4. Kick off

1. Ask the owner whether the build can push its branch and open its pull
   request, unless the owner already said so in this conversation. Only the
   owner answers this; never assume it.
2. Freeze: `aio-build freeze SLUG [PLAN_FILE] --push yes|no`. Leave out
   `PLAN_FILE` to freeze the draft. A changed plan becomes the next version;
   frozen versions never change.
3. Start: `aio-build start SLUG`.
4. Tell the owner the build runs on the branch `build/SLUG`, that they can
   watch it in the Builds area of the Boxes app, and that you report each
   escalation and milestone.

Kickoff is done when `aio-build status SLUG` shows the build running.

## 5. Run the build

The engine types a one-line pointer into this session for each escalation
and digest:

```
[aio-build SLUG ID] SUMMARY. Read PATH
```

Read the file at `PATH`, then triage it with the `triage.md` file beside
this skill. You don't poll; pointers arrive on their own. A missed pointer
waits in `aio-build inbox SLUG`.

Owner requests during execution map to requests:

- Pause or continue: `aio-build pause SLUG`, `aio-build resume SLUG`.
- Cancel: `aio-build cancel SLUG`, only on the owner's explicit word.
- What the agents said: `aio-build messages SLUG [--direct]`.
- Owner posts that conflict with the plan: `aio-build decisions SLUG`.

The build never merges. After the owner merges, tag and release with the
`release-versioning` skill only when the owner tells you to.
