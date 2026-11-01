# Review pipeline

The review pipeline reviews a branch with several AI vendors, verifies each
finding, has Claude fix the real ones, and repeats until the branch is
clean. This page describes the vendors' roles, the profiles, the stages, the
conditions that stop a run, the decisions a run can ask you for, and the
guardrails after a push.

The engine inside each project container runs the pipeline. Every stage
writes its output as JSON under `PROJECT/.aio/runs/RUN_ID/`, so a run
can resume from any stage. Replace `PROJECT` with the project root and
`RUN_ID` with the run's ID.

## Vendors and roles

Claude writes and fixes all code. The other roles move between vendors
according to the profile and the usage ceilings.

| Vendor | CLI | Roles |
|---|---|---|
| Claude | `claude -p` | Fixer, always. Reviewer and disprover when the profile allows. |
| Codex | `codex exec` | Reviewer, disprover, and fix confirmer. |
| GitHub Copilot | `copilot -p`, with automatic model selection | Reviewer. Pull request reviewer after the push. |

A run has four roles: `reviewer` (one or more vendors), `disprover`,
`confirmer`, and `fixer`. By default, the disprover and the confirmer come
from a vendor other than the one that did the work.

## Profiles

A profile sets how much of the review Claude does. You pick one when a run
starts, and you can switch it during the run. The scheduler reads the
profile at the start of each round.

| Profile | Claude's share | Use it when |
|---|---|---|
| `offload` (default) | Fixes only. Codex and Copilot review and disprove each other's findings. | You want to keep your Claude usage for other work. |
| `balanced` | Reviews rounds 1 and 2, then fixes only. | You want a strong first pass. |
| `fast` | Reviews every round next to Codex, with focus-area reviewers on major groups, and disproves Codex findings. | You want the fewest rounds and the least time. |

To switch the profile of a running run, use the **Profile** control in the
run view, or run `aio review profile RUN_ID PROFILE`. To move a role to
another vendor from the next round, run
`aio review assign RUN_ID ROLE VENDOR`.

## Accounts

In accounts mode, each model call of a run uses its vendor's default
account: the engine sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or
`COPILOT_HOME` to the account folder that the server names in the
container's `account-dirs.json` file. A change of default applies from the
next call. In host mode, the CLIs use the container user's `~/.claude`,
`~/.codex`, and `~/.copilot`. For more information, see
[Accounts](accounts.md).

## Usage ceilings

Usage belongs to an account, not a container, so the server keeps one
ceiling per vendor across every project. Before each model call, the engine
asks the server for a lease. The server grants it, moves the role to another
vendor, or tells the run to pause until the vendor's window resets.

The default ceilings are the following:

| Vendor | Ceiling |
|---|---|
| Claude | 60% of the 5-hour window |
| Codex | 70% of the 5-hour window |
| Copilot | $70 per month |

When a vendor passes its ceiling, the server moves its pending review and
disprove roles to the next vendor. The fixer stays with Claude: when Claude
passes its ceiling, the run pauses until the window resets and notifies you.
You can change the ceilings in the settings, and override them per project.

To see each vendor's usage, ceiling, and reset time, open the usage view or
run `aio review usage`.

## Review range

A run reviews the changes between a base and a tip:

- **Base**: a branch, tag, or commit. Default: `origin/main`. With `pr`, the
  base is the open pull request's base branch. The run pins the base to a
  commit when it starts.
- **Tip**: the branch to review and fix. Default: the checked-out branch.
  Each round reviews the tip as it stands after the previous round's fixes.
- **Merge base**: by default, the diff starts at the merge base, as
  `git diff BASE...TIP` does, so changes that landed on the base after you
  branched stay out. **Exact base** diffs against the base commit itself.
- **Read-only**: reviews without fixing. Use it with a commit as the tip.
- **Uncommitted changes**: a run refuses a dirty working tree unless you
  turn on **Include uncommitted changes**.

## Pre-push stages

Each round of a pre-push run goes through the following stages:

1. **Preflight**: resolves the range and records a baseline run of the
   repository's tests and lint commands from the policy file.
1. **Group**: groups each changed file with its tests and docs and classifies
   each group as major or minor by size. A file that matches a risk path in
   the policy file makes its group major. A group larger than the policy's
   size limit splits.
1. **Find**: runs fresh, read-only reviewers in parallel. Each reviewer gets
   the findings already fixed or disproved, must give a verdict for every
   diff hunk, and continues in the same session until it finds nothing new.
   Reviewers, disprovers, confirmers, and sweepers read a checkout of the
   tip that the engine owns, not your checkout, so you can keep working
   while they run.
1. **Merge**: removes duplicate findings, and records the overlap rate
   between reviewers. Two findings are duplicates when they have the same
   fingerprint, or when their lines overlap in the same commit and their
   titles or failure cases share at least half their words.
1. **Verify**: a disprover from another vendor tries to disprove each
   finding, with a reproduction script where it can, and checks whether the
   flaw already exists at the base. The engine reruns each script in a
   throwaway checkout of the tip and of the base, and stops it when you
   cancel the run.
1. **Fix**: Claude fixes the confirmed findings on the tip branch and commits
   each batch.
1. **Gate**: reruns tests and lint in your checkout, where the dependencies
   are. A regression against the baseline sends the round back to the fix
   stage. The gate never deletes files: untracked files that appear while
   it runs, such as build output, stay, and the engine log lists them. Add
   build output to `.gitignore`, or the next run refuses the dirty tree.
1. **Confirm**: a reviewer from a vendor other than the fixer checks the fix
   diff for incomplete fixes and regressions.
1. **Sweep**: turns each confirmed finding into a pattern and searches the
   whole diff for other instances.

## Stop conditions

A run ends, or stops for you, when one of the following holds:

| Condition | Result |
|---|---|
| Clean | Two rounds in a row confirm no finding above `nit`. The branch is ready to push. |
| Round cap | The run reaches its round limit, 25 by default. The run stops and asks you. |
| Oscillation | A finding that a fix closed comes back. The run stops and asks you. |
| Ceiling | Claude is over its ceiling and no other vendor can take the role. The run pauses until the window resets, or asks you. |
| Gate failed | Tests or lint stay broken after the fix stage. The run asks you. |
| Push blocked | The post-push loop can't push. The run asks you. |
| Cancelled | You cancelled the run. |

High overlap isn't a stop condition. When more than half of the findings
come from more than one reviewer for two rounds, the scheduler alternates
the vendors across rounds instead of running them side by side.

## Decisions

A run that stops for you shows the reason and the findings involved, and
offers some of the following choices:

- **Resume**: continue the run unchanged.
- **Resume with this finding waived**: continue and record the finding as
  waived, with your reason, so later rounds don't raise it again.
- **Cancel**: end the run.

For an oscillation, the run view shows both versions of the finding. From a
terminal, `aio review resume RUN_ID` resumes a paused or waiting run,
and `aio review cancel RUN_ID` cancels it.

## Post-push loop

After you push from a run's summary, the post-push loop runs on the pull
request:

1. Pushes the branch, opens or updates the pull request, and requests a
   Copilot review.
1. Polls the pull request until the Copilot review and the checks finish.
1. Imports the review comments and the logs of failing checks as findings.
1. Has Codex verify each comment. For a comment it disproves, the loop
   replies on the thread with the evidence instead of changing code.
1. Has Claude fix the confirmed findings, runs the gate, and pushes.
1. Replies to and resolves each addressed thread, and requests another
   Copilot review.

The loop ends when the Copilot review raises no new actionable comment and
the checks pass, or when the only failing checks have causes outside the
code, such as infrastructure or missing secrets. The round cap and the
oscillation check apply here too.

### Guardrails

The post-push loop works under the following rules:

- It never force-pushes.
- It never pushes to the repository's default branch.
- It never merges. When the pull request is mergeable, the review app shows
  its link and you merge it.
- It answers a disproved comment with evidence instead of a code change.
- It never runs for a read-only run. The CLI, the server, and the engine
  refuse a read-only request for the post-push pipeline, because the loop
  pushes and commits fixes.

## Repository policy

Each repository can carry a policy file with risk paths, extra review rules,
test and lint commands, and environment limits. For more information, see
[Policy file](policy.md).
