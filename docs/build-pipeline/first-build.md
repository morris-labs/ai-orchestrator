# Run your first build

This page shows you, the owner, how to run a build from request to pull
request. You talk to one session, the Project manager, and the build team
works in the background. For the design behind it, see
[Build pipeline design](design.md).

## Before you start

Check the following:

- You run AI Orchestrator in accounts mode, and the box runs Claude Code.
  The Project manager role runs only in a Claude box; the `aio-build` skill
  refuses to run in a Codex or Copilot box.
- The project has a policy file, `.aio/policy.yaml`, with the setup, test,
  type check, and lint commands. The build plan takes its commands from it.
  A build starts in a fresh worktree, so the `setup` list must install the
  dependencies there. For more information, see [Policy file](../policy.md).
- The box's container started with this version of AI Orchestrator. A
  container from an earlier version lacks the `aio-build` command or the
  project ID it needs; restart the project's boxes to recreate it.

## The aio-build skill

The server installs the `aio-build` skill into each Claude account at every
start, in the `skills/aio-build/` folder of the account. It replaces any
copy of that folder's files that differs from the installed package, and it
changes nothing else in the account. An account that the server didn't see
at its start, such as a seeded account, gets the skill at its first box
start. Edits that you make to the skill's own files don't survive a server
start; to change the Project manager's behavior, add instructions to the
account's `AGENTS.md` file instead.

## Ask for a build

In the box's main session, describe what you want built and say that it's a
build, for example:

```
Build a total for the shopping cart, using the build pipeline.
```

To start from a GitHub issue, name the issue instead, such as
`example-org/shop#42`. The build plan links back to it.

The skill gives the session the Project manager role. The Project manager
restates the request, asks what's unclear, and settles the build's size
with you.

## Plan a small build

A small build is a bug fix or a change that one Developer makes in one task
with one failing test. For a small build, the Project manager writes the
spec and the plan itself, without the Analyst, the Architect, or the
Critic. It shows you the plan's acceptance criteria and the task, and you
approve it or ask for changes.

## Plan a medium or large build

For a medium or large build, the Project manager runs the planning team
while it keeps talking with you:

1. The Analyst writes the spec. The Project manager shows you the
   acceptance criteria, the size, the expected usage, and the secrets and
   services that the build needs. Ask for changes until the spec is right.
1. The Architect writes the design: the milestones and the task graph.
1. The Critic attacks the design in a meeting. The Project manager reports
   the outcome and any open objections before it asks for your approval.

Each step can take many minutes. The Project manager runs them in the
background and tells you when each one answers. To pass a remark to a
running Critic meeting, tell the Project manager; it relays your words to
the meeting.

Before you approve, tick each secret that the plan lists in the box's
**Secrets (project)** section. For more information, see
[Secrets](../secrets.md).

## Approve and start

When the plan is right, approve it in plain words. The Project manager then
does the following:

1. It asks whether the build can push its branch and open its pull request,
   unless you already said so. The build plan records your answer. Without
   push permission, the build keeps its branch local.
1. It freezes the plan as version 1 in the `.aio/builds/SLUG/plans/`
   directory of the project. A later change becomes the next version.
1. It starts the build on the `build/SLUG` branch, in a worktree of its own.
   Your checkout stays untouched.

In these paths, `SLUG` is the build's short name, such as `cart-total`.

## Follow the build

You can watch the build in the Builds area of the Boxes app, or leave it
alone. The engine types a one-line pointer into the Project manager's
session for each escalation and each milestone digest, and the Project
manager reports to you:

- **Escalations it resolves itself:** retries, task order, and
  clarifications that the plan already implies. It tells you what it
  decided.
- **Escalations for you:** a missing secret or service, a change to the
  acceptance criteria, the scope, or the milestones, and the push answer.
  It asks you, and passes your answer on word for word.
- **Milestone digests:** what finished, the attempts, and the usage by seat.

To pause or continue the build, tell the Project manager. Stopping the box
also pauses the build, and starting the box resumes it. Cancel a build only
when you mean it; a cancelled build keeps its branch and stays resumable
until you delete it.

The Project manager's session can compact or restart during a long build.
The skill has it reread the build's `STATUS.md` file, the build plan, and
its inbox before it acts again, so you don't need to repeat anything.

## Finish

The build ends release ready: the review pipeline reports the diff clean,
CI passes, and the docs, the changelog entry, and the pull request
description are written. The Project manager tells you the branch, the pull
request, and the checks that it leaves to you. The build never merges.
After you merge, tell the Project manager whether to tag and release.

## Related pages

- [Planning a build](planning.md)
- [Escalations](escalations.md)
- [Delivery to the Project manager](pm-delivery.md)
- [Owner posts and direct messages](owner-posts.md)
