# Daily flow

This page walks through a typical day with Agent Box: you create a box for a
piece of work, let the agent work, review its branch with the pipeline, and
push. Each step names the app action and the matching `agentbox` command.

A *box* is one conversation with a coding agent. It runs as a tmux session
in its project's container, in its own git worktree on its own branch. A
*project* is a directory; all boxes in a project share one container.

## Create a box

1. In **Agent Box**, pick a project in the project list.
1. Click **New box**, type a conversation name, and click **Create**.

Agent Box creates a worktree at `PRIMARY_REPO/.worktrees/SLUG` on the branch
`claude/SLUG`, starts the project container if it isn't running, starts the
agent's session, and opens a terminal tab on it. You don't choose any ports.

From a terminal, run `agentbox box new`. For the options, run
`agentbox box new --help`.

## Work

While the agent works, the following happens without any setup:

- **Dev servers**: When a process in the container listens on a port, the
  box's details panel shows a link to it, in the form
  `http://PORT.BOX.localhost:21400/`. The engine finds listening ports and
  the server proxies them.
- **Secrets**: The project's 1Password references arrive in the container as
  environment variables. For more information, see [Secrets](secrets.md).
- **Notes**: The agent keeps its `PLAN.md` and `STATUS.md` files in
  `WORKTREE/.claude-box/`, which git ignores.

The terminal tab is a tmux client. To detach without stopping the agent,
press Control+B, then D. To attach again, double-click the box or run
`agentbox box attach BOX`.

Replace the following:

- `PRIMARY_REPO`: the project's primary repository, usually the project root
- `SLUG`: the conversation name, reduced to letters, digits, and
  underscores
- `PORT`: the port the dev server listens on inside the container
- `BOX`: the box's short host key, shown in the details panel
- `WORKTREE`: the box's worktree directory

## Review

To review the box's branch, right-click the box and click **Start review**,
or click **Review** on the toolbar.

**Agent Box Review** opens with the run launcher filled in:

| Field | Value |
|---|---|
| Repository | The box's repository |
| Base | `origin/main` |
| Tip | The box's branch |
| Profile | `offload` |

Click **Start**. The box shows an **under review** badge, and its agent
session receives one message that asks it to hold edits until the run ends.
The run refuses to start when the worktree has uncommitted changes. Ask the
agent to commit, or start the run with **Include uncommitted changes**.

From a terminal, run `agentbox review start`.

## Watch or leave

The dashboard in **Agent Box Review** shows the run live: the stage, the
round, each agent call, the findings per vendor, and each vendor's usage
against its ceiling. You don't need to watch it. A desktop notification
arrives in the following cases:

- The branch is ready to push.
- A round completes. To turn round summaries off, change the notification
  settings.
- The run needs a decision from you.
- A box session ends unexpectedly.

Click a notification to open the run.

## Decide

When a run stops for a human decision, it shows the reason, the findings
involved, and the following choices:

- **Resume**: continue the run as it is.
- **Resume with this finding waived**: continue, and stop raising the
  finding.
- **Cancel**: end the run.

For an oscillation, where a fixed finding came back, the run shows both
versions of the finding side by side. For the reasons a run stops, see
[Review pipeline](review-pipeline.md#stop-conditions).

## Push

When the run reports the branch ready, click **Push and open pull request**
in the run's summary. Agent Box pushes the branch, opens the pull request,
and starts the post-push loop, which imports review comments and failing
checks, verifies them, fixes what's real, and pushes again. The loop never
force-pushes and never pushes to the default branch.

## Merge

When the post-push loop reports the pull request mergeable, **Agent Box
Review** shows the pull request link. Merging stays your decision: open the
link and merge on GitHub.
