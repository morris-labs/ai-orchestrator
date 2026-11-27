# Route builds by size to a single session

Status: accepted

A build runs in one of two flows: the pipeline, through the full build
team, or the single-session flow, in which one Developer session works the
approved acceptance criteria, one review run checks the whole diff, and the
review's fixer resumes that same session to fix the confirmed findings. The
single-session flow keeps planning, preflight, the task gate, the review
step, and release ready, and skips the Contracts step, tests first, the
criteria trace, and the Scribe. It records usage by seat and step like a
pipeline build, so the two flows compare over time.

The Analyst's build size sets the recommendation through a size threshold.
A small or medium task that isn't high-risk gets the single-session flow,
and a large or high-risk task gets the pipeline. A task is high-risk when it
changes stored data, runs a migration, or crosses an account or security
boundary across several packages. The engine refuses a spec whose
recommendation breaks the threshold. The Project manager shows the
recommendation before the Architect starts, the owner chooses either flow,
and the freeze refuses a plan without that choice.

The phase 1 measurement compared the pipeline with one top-tier session
followed by one review run, and the pipeline didn't pay off on the small or
the medium task. On T1, a bug fix, it used about 0.9 times the baseline's
tokens in and twice the working time. On T2, a medium feature, it used about
4.3 times the tokens in and needed five owner interventions against one.
Both arms ended with equal final review results, and the baseline met 13 of
14 criteria. Under ADR 0006, the pipeline's extra seats haven't earned their
cost at those sizes, so the cheaper flow is the default recommendation there.

The threshold is provisional. A remeasurement with a fixed pass bar of at
most 1.5 times the baseline's tokens in decides the default flow for each
size. If the pipeline fails the large task too, the single-session flow
becomes the default for every size, and the parts of the pipeline that
helped move into it.

## Considered options

- **Run every task through the pipeline.** This option was rejected because
  the measurement showed that a small or medium task costs more and takes
  longer through the pipeline, for the same final review result.
- **Leave the flow to the owner, with no recommendation.** This option was
  rejected because the owner would need the measurement's evidence at hand
  on every build. The recommendation states it, and the owner still decides.
- **Let the engine choose the flow from the size.** This option was
  rejected because a medium task with high risk, or a large task that the
  owner knows to be simple, can need the other flow. Direction stays the
  owner's decision.
- **Run the single-session flow outside the build pipeline, as a box
  session and a stand-alone review run.** This option was rejected because
  the flow would lose the approved criteria, the task gate, the escalations,
  and the usage by seat and step that make the two flows comparable.

## Consequences

- The build plan carries the Analyst's recommendation and the owner's
  `flow`, and the status file shows both.
- A single-session build locks no tests and writes no decision records,
  glossary entries, or changelog entry. Its pull request lists the
  criteria as the plan states them.
- Changing the threshold, after the remeasurement or a later one, changes
  the Analyst's rule and the engine's check together.
