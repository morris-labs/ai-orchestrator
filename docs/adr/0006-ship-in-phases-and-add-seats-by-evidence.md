# Ship in phases and add seats by evidence

Status: accepted

The build pipeline ships in two phases. Phase 1 carries the mechanisms with
the most effect on quality for their cost: acceptance criteria, tests first
on a different vendor, the task gate, one Critic meeting, and the review
pipeline. A measurement then compares phase 1 against one top-tier session
followed by the review pipeline, on the same tasks, with usage attributed to
each seat. A phase 2 seat or step joins the default flow only when that
measurement shows a gap that it closes.

Each added seat costs tokens on every build, and an agent team can spend far
more than one session for a small gain in quality. Without the baseline and
the usage by seat, nobody can tell which seats earn their cost.

## Considered options

- **Build the whole design at once.** This option was rejected because the
  first evidence would arrive after every workstream was paid for.
- **Per-build quota budgets.** This option was rejected earlier in the
  design. The usage watcher alerts on burn rate and on twice the Analyst's
  usage estimate, and the owner decides whether to pause.
