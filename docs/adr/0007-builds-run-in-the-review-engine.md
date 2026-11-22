# Builds run in the review engine

Status: accepted

The build state machine runs in the `aio-engine` process, beside the review
state machine. Before this decision, the engine was built around one review
run: its run state, its controller, and its agent-call code all assumed a
review range. The agent-call code moves out of the review run into a shared
core that both state machines use. The core covers leases, tiers, the limit
fallback, the call cache, events, and the guard on the working tree. Build
types get their own names, such as `BuildTask` and `BuildRole`, and the
review types keep theirs.

The extraction ships first, as a release that changes no review behavior.

## Considered options

- **A separate build engine process:** review code stays untouched. Rejected:
  leases, usage records, and vendor adapters would exist twice, and the
  keeper script would supervise two processes that compete for the same
  vendor limits without one scheduler.
- **A build as a kind of review run:** rejected. A review run is a range of
  commits and a fixed list of stages. A build has a build plan, tasks, and
  messages, and it starts review runs of its own.
- **Rename the review terms that the build pipeline also uses:** rejected.
  Saved review runs would need a state adaptation, and the docs would change,
  for no gain to the owner.

## Consequences

- The server accepts events from builds as well as from review runs.
- A lease names a seat and a step as well as a review role, so usage counts
  by seat.
- A change to the shared core can break both pipelines, so both test suites
  run on every such change.
