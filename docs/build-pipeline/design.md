# Build pipeline design

This document describes the build pipeline, a sister to the review pipeline in
AI Orchestrator. The build pipeline takes a request from a planning
conversation to a release-ready pull request. A team of role-based agents
does the work, the way a small development team does. For the terms this
document uses, see the `GLOSSARY.md` file at the repository root.

A build can be as small as a bug fix or a settings page, or as large as a
whole new app.

## Principles

The build pipeline keeps every principle of the review pipeline: a program
runs the loops, every handoff is a file, vendors check each other,
deterministic work stays deterministic, and every loop has an exit. It adds
the following principles:

- **Plan by conversation, execute by code.** Planning needs judgment and the
  owner, so it happens in a conversation. Execution needs repetition and
  patience, so the engine runs it with rule-based routing.
- **One voice for the owner.** The owner talks to the Project manager. Every
  other agent works behind it, and the owner can still watch and join any
  conversation in the team chat.
- **Roles are data.** Each role is a definition file. Adding or changing a
  role needs no engine change.
- **Small core, specialists on demand.** Every build seats the core team. The
  bench and on-call roles join only when the project or a trigger calls for
  them.
- **Specs and tests before code.** Developers work against acceptance
  criteria and against tests that a different agent wrote. A Developer never
  grades its own work.
- **The owner approves direction, not keystrokes.** The owner approves the
  build plan and anything that changes what the build delivers. Everything
  else runs unattended.
- **The repository holds the record.** Each decision, with its reason, lands
  in the repository, so the owner can learn months later why something works
  the way it does.
- **Seats earn their place.** The pipeline ships in phases. A seat or a step
  joins the default flow only when measurements show that it improves the
  result for its cost.

## Phases

A build has two phases with one handoff between them.

### Planning

Planning is a conversation between the owner and the Project manager, which is
the box's main Claude Code session. An `aio-build` skill gives the session
the Project manager role. The Project manager runs the planning team behind
the conversation:

1. The Analyst turns the request into a spec: stories, edge cases, numbered
   acceptance criteria, a verification method for each criterion, a size
   estimate, and the secrets and external services the build needs.
2. The Librarian answers questions about the existing code and earlier
   decisions.
3. The Architect writes the architecture, the contracts, the milestones, and
   the task graph.
4. Specialists add design consults, such as privacy constraints.
5. The Critic attacks the plan in a meeting. The Architect revises it until no
   major objection remains or the meeting reaches its round cap.
6. The engine records each decision as a file when it happens. The Scribe
   turns those files into the committed record.

A request can start as free text or as a GitHub issue. A build plan that
starts from an issue links back to it. Only the owner starts a build. An
issue is input to planning, and nothing starts a build from an issue by
itself.

When the owner approves, the Project manager freezes and versions the build
plan in the `.aio/builds/SLUG/` directory and starts execution through the
skill. Replace `SLUG` with a short kebab-case name for the build.

At approval, the Project manager asks whether the build can push its build
branch and open its pull request, unless the owner already said so. The build
plan records the answer. Without that answer, the build stops at an
escalation before the push.

### Execution

The engine carries out the build plan in the background. The owner watches in
the Builds area of the Boxes app, or not at all. Execution ends
when the build is release ready or when it needs a decision that only the
owner can make.

## Build size

The Analyst estimates a build size, and the owner can change it. The size
sets the seats, as the following table shows:

| Size | Example | Planning | Execution |
|---|---|---|---|
| Small | A bug fix | The Project manager writes the spec and plan itself. No Critic. | One Developer |
| Medium | A settings page | The full planning team, with one Critic meeting | Up to three Developers in parallel |
| Large | A new app | The full planning team, with a Critic meeting for each milestone plan | The release train by default, with the Integrator on call |

## Team

The following sections list the roles. Each role is a Markdown file with YAML
front matter that holds the role's purpose, activation, inputs, outputs and
their schemas, permissions, default placement, and rules. AI Orchestrator
ships the role library. A repository overrides a role by name, or adds one,
in its `.aio/team/` directory. During planning, the owner can tell the
Project manager to change a role's rules for one build, and the Scribe
records the change in the build plan.

For the fields of a role file and how the engine loads it, see
[Role definition format](roles.md).

### Specialties

Each agent runs as its own session, which the engine starts from the role
definition. No two agents share a context.

A specialty is a named pack of guidance for one technology, such as Node.js,
TypeScript, or Go. The Architect tags each task with its specialties, and the
engine adds those packs to the prompt of every agent that works on the task:
the Developer, the Test engineer, and the fixer. A task can have several.

A role sets the job and its rules. A specialty adds knowledge of the
technology. One Developer role therefore covers every technology, and a
technology that needs different rules gets a role file of its own.

A specialty names a skill in the account's skills folder, and the engine
reads that skill's text for an agent on any vendor. A repository adds its own
specialties in its `.aio/team/specialties/` directory. Usage reports break
down by seat and by specialty.

### Core team

Every build seats the core team, scaled by build size.

| Role | Purpose | Output |
|---|---|---|
| Project manager | The owner's single point of contact. It runs planning, triages escalations, and directs the build team. | Decisions, directions, and digests |
| Analyst | Turns the request into a spec | The spec and acceptance criteria |
| Architect | Designs the structure and splits the work | The architecture, contracts, milestones, and task graph |
| Critic | Attacks the plan before any code exists | Objections with severities |
| Test engineer | Writes tests from the criteria before the code exists, then tries to break the integrated code | Tests, fixtures, UI checks, and bug reports |
| Developer | Writes the code for one task, and fixes review findings | Commits on a task branch |
| Simplifier | Removes bloat without changing behavior | A cleanup commit |
| Scribe | Writes the record | ADRs, glossary entries, the architecture doc, the walkthrough, changelog entries, and closing records |
| Librarian | Reads the record and the code | Answers about the code and earlier decisions |

### Bench

The engine seats bench roles from the project's traits and its policy file.

| Role | Seated when | Output |
|---|---|---|
| UI designer | The project has a user interface | Component hierarchy, design tokens, and interface text |
| Data engineer | The project has a database or complex queries | Schemas, migrations, and index plans |
| DevOps engineer | The project ships containers, CI, or deployments | Container files, CI workflows, and environment templates |
| Technical writer | The project is public, exposes an API, or needs setup docs | The README, API reference, and guides |

### On-call roles

The engine activates an on-call role when its trigger fires. Every trigger
runs as code. The Project manager can also seat any role by hand.

An on-call role takes one of two forms. A seat puts an agent to work. A review
lens adds a focus area to the build's next review pipeline run and starts no
agent of its own.

| Role | Trigger | Form |
|---|---|---|
| Debugger | Two gate failures in a row on one failure fingerprint | Seat |
| Integrator | A merge conflict, or a contract test that fails after a merge | Seat |
| Migration specialist | A change to a schema, a public API, or a stored format | Seat |
| Performance engineer | A change to a hot path that the policy file marks, or a failed performance budget | Review lens |
| Dependency auditor | A change to a lockfile or a dependency manifest | Review lens |
| Privacy reviewer | A change to a regulated-data path that the policy file marks | Review lens |
| Accessibility reviewer | A change to user interface files | Review lens |

### Specialist hooks

A specialist role can contribute in two ways, and it has no stage of its own:

- **Design consult:** during planning, it adds constraints and acceptance
  criteria to the spec.
- **Review lens:** during execution, it adds a focus area to the review
  pipeline's reviewers.

Security works this way too. Its review lens is always on, and its design
consult runs when a build touches risk paths.

## Placement

Each seat has a placement: a vendor, a model tier, and an effort. The tiers are
the review pipeline's `large`, `medium`, and `small` tiers, which map to
concrete models in the policy file. Each of the following levels overrides
the one before it:

1. The role library default.
2. The single-vendor setting, which places every seat on one vendor.
3. The build plan.
4. A live change during execution, which takes effect when the next agent
   starts in that seat.

The following table lists the defaults:

| Role | Vendor | Tier | Effort |
|---|---|---|---|
| Project manager | Claude | The box's model | The box's effort |
| Analyst | Claude | Large | Medium |
| Architect | Claude | Large | High |
| Critic | Codex | Large | High |
| Test engineer | Codex | Large | Medium |
| Developer | Claude | Large | Medium |
| Debugger | Claude | Large | High |
| Simplifier | Claude | Medium | Medium |
| Integrator | Claude | Medium | Medium |
| Design consults and bench roles | Codex | Medium | Medium |
| Scribe | Codex | Medium | Low |
| Librarian | Codex | Small | Low |

Copilot is off by default because of its small allowance, and no step
requires it. The owner can turn
it on for a build as a second Critic or as a pull request reviewer. With
the single-vendor setting, a rule that requires another vendor falls back to a
fresh session on the same vendor.

## Team chat

The team chat is where agents exchange messages and where the owner watches
and joins in. AI Orchestrator owns it as a message bus, and agents from every
vendor reach it through an MCP server.

Every message is a file in the build's directory, and the app displays those
files as a conversation. An agent doesn't write a chat message about its
work. The handoff, the question, the meeting reply, or the bug report is the
message.

### Messages

Each message has a sender, an addressee, a type, a task or milestone, and a
body. The engine delivers a message straight to its addressee. The Project
manager isn't in the path, so a message costs tokens only in the context that
receives it. The Project manager receives digests that code builds, not the
raw traffic.

When a message names no addressee, the engine routes it by type:

- **Test dispute:** to the Test engineer.
- **File request:** to the Developer of the task that owns the file.
- **Contract question:** to the Architect.
- **Any other type:** to the Project manager.

An agent can send five questions per task, a cap that the build plan can
change. A question past the cap goes to the Project manager as an escalation.

### Owner posts

The owner can post to any agent, and only that agent spends tokens. The
engine records each owner post as a decision and attaches it to the task.
The tests, the UI checks, the reviewers, and the Simplifier then work from
the post and don't undo it. When an owner post contradicts an acceptance
criterion, the engine flags the post to the Project manager as a change to
the build plan.

### Direct messages

An agent can message the owner directly, for example to raise a concern that
the Project manager dismissed. Each agent has a rate limit, such as two
direct messages per milestone. A direct message doesn't pause work by itself,
and the Project manager and the record can see every one.

### Session resume

The engine stores the session ID of every agent, with its seat and task. When
a message arrives for an agent whose turn ended, the engine resumes that
session, so the agent doesn't rediscover the code. Three rules apply:

- **Size:** a resumed session rereads its whole history, at full price after
  the vendor's prompt cache expires. When a session is larger than a set
  threshold and its cache expired, the engine starts a fresh agent with the
  task's files and the message thread instead.
- **Staleness:** the engine adds a summary of the commits that landed after
  the session's last turn.
- **One turn at a time:** the engine queues the messages for each session.

### Views

The app filters the messages by task, milestone, and seat. A slice is the set
of messages that one agent received, and the owner can view each agent's
slice. Channels and side chats, which group messages into threads with
several members, are a phase 2 addition.

### Meetings

The Project manager opens a meeting for one proposal. Each turn is a message,
and code takes the turns:

1. The proposer posts the proposal.
2. Each invited role replies once per round. A reply is concise and
   structured, with a soft cap of about 200 words that the role definition can
   change. It states a position (object, concern, or no objection), a severity
   (major or minor) for each point, and the reasons.
3. The proposer revises. The meeting repeats until no major objection
   remains, or until it reaches its round cap, which defaults to three.
4. The Project manager reports the outcome and any open objections.

The owner's posts in a meeting jump the queue. Every member reads them at its
next turn.

## Milestones

A build has one or more milestones, each a working and tested increment.
The build plan sets one of two delivery modes:

- **Single PR (the default for small and medium builds):** milestones are
  checkpoints on one build branch, and the owner gets one pull request.
- **Release train (the default for large builds):** each milestone becomes its
  own pull request. When the owner hasn't merged milestone N yet, milestone
  N+1 stacks on its branch. When the branch of milestone N changes after
  milestone N+1 starts, the engine rebases milestone N+1 and reruns its
  full suite. A conflict seats the Integrator.

Task branches and integration branches stay internal. In single PR mode, the
build moves to the next milestone without waiting and sends the owner a
digest. The owner can tell the Project manager to pause after any milestone.

### Preflight

Before the first milestone, the engine checks that the test, type check, and
lint commands that the build plan names all run. It then records a baseline
from three runs of the repository's tests:

- **Known failing:** a test that fails in every run. It doesn't block the
  build or count as a regression.
- **Flaky:** a test whose result differs between runs. The engine quarantines
  it. Its result doesn't block the build, count as a regression, or feed a
  failure fingerprint.

The Scribe lists both kinds in the pull request.

### Milestone loop

Each milestone runs these steps in order:

1. **Contracts.** A Developer writes the shared types and interfaces, with
   stubs, so that tests compile against the real signatures.
2. **Tests first.** The Test engineer writes the milestone's acceptance and
   contract tests from the criteria and the contracts. The engine checks the
   tests and locks them.
3. **Tasks.** Developers work tasks from the task graph in dependency order,
   each in its own Git worktree. Each Developer gets a context pack that code
   assembles from the task: its owned files, contracts, criteria, tests, and
   attached decisions.
4. **Integrate.** The engine merges task branches in dependency order and runs
   the full suite.
5. **Harden.** The Test engineer tries to break the integrated code. Its bug
   reports use the review pipeline's finding schema. Each report includes a
   failing test, which joins the locked tests.
6. **Simplify.** The Simplifier cleans up, and the tests must stay green.
7. **Review.** The engine starts a review pipeline run, with the review lenses
   of every seated specialist as focus areas. The Developer seat fills the
   fixer role.
8. **Release ready.** In release train mode, the milestone goes to the
   post-push loop. In single PR mode, the next milestone starts.

The review pipeline runs once for each pull request. In release train mode,
it runs on each milestone diff. In single PR mode, it runs one time, on the
whole build diff after the last milestone, and the earlier milestones end
with the full suite.

The build size sets which steps run, as the following table shows:

| Step | Small | Medium | Large |
|---|---|---|---|
| Contracts | Skipped | Runs | Runs |
| Tests first | One failing test for the change | Runs | Runs |
| Tasks | One task | Runs | Runs |
| Integrate | Skipped | Runs | Runs |
| Harden | Skipped | Last milestone only | Each milestone |
| Simplify | Skipped | Last milestone only | Each milestone |
| Review | Runs | Runs | Runs |

### Tests first

The tests are the standard that grades the build, so the engine checks them
before any Developer starts:

- **Criterion IDs:** each test names the acceptance criterion that it serves.
- **Red check:** the engine runs the tests against the contract stubs. Each
  test must fail on an assertion, not on a syntax, import, or setup error. A
  test that passes before the code exists goes back to the Test engineer,
  unless the build plan marks its criterion as one that already holds.
- **Coverage check:** in medium and large builds, an agent on a different
  vendor from the Test engineer reads each criterion with its tests, one
  time. It reports each criterion that the tests don't check, and the Test
  engineer revises once.
- **Test lock:** the engine records a hash of each test file. The gate fails
  a Developer commit that changes a locked file. A Developer can add tests of
  its own.

A Developer that believes a locked test is wrong sends a test dispute with
its reason. The dispute goes to the Test engineer, not to the Project
manager, and it doesn't count as a gate attempt. It ends in one of these
ways:

- **Amended:** the Test engineer fixes the test. The engine locks the fixed
  version and records the amendment with its reason.
- **Rejected:** the Test engineer answers with its reason, and the Developer
  continues.
- **Ruled on:** a second dispute about one test, or a third dispute in one
  task, goes to the Project manager.
- **Escalated:** an amendment that changes what a criterion means is a change
  to the acceptance criteria, so it goes to the owner.

### Tasks

A task is the smallest unit of work in the task graph. Each task has the
following:

- An owned file set, which the Architect assigns.
- The contracts that it implements.
- The acceptance criteria IDs that it serves.
- The tests that must pass.
- Its dependencies.

The Architect sizes a task for about one focused agent session and splits
anything larger. The default cap is three parallel Developers, and the build
plan can raise it.

The Architect predicts each owned file set from the code that exists, and a
prediction is often incomplete. The engine enforces the sets and repairs
them:

- The gate compares each task's diff with its owned file set.
- A file that the task creates, or a file that no task owns, joins the task's
  set, and the engine records the change.
- A change to a file that another task owns fails the gate. The Developer
  sends a file request. When the owning task hasn't started or is finished,
  the engine grants the request and adds a dependency between the two tasks.
  Otherwise, the owning task's Developer makes the change.
- The build plan lists the shared files, such as dependency manifests,
  lockfiles, route indexes, and migration lists. Any task can declare a
  shared file, and the engine doesn't run two tasks that declare the same
  shared file at the same time.

### Task gate

After each Developer attempt, the gate runs these checks:

- The task's tests.
- The tests that earlier tasks in the milestone made pass.
- Type checks and lint.
- The test lock and the owned file set.

When a test fails, the gate runs it one more time. A test that then passes
is flaky, and the engine quarantines it. When the build wrote that test, it
also goes back to the Test engineer.

A failure fingerprint is the set of failing checks, each with its first error
line after the engine strips line numbers, paths, addresses, and timestamps.
When the gate fails twice in a row on the same failure fingerprint, the
engine seats the Debugger, and the Developer applies its diagnosis. After four
attempts, the task escalates.

### Review findings

Inside a build, the review pipeline's stages run unchanged. The fixer runs
with the Developer seat's placement and the task context, as a fresh agent.
A finding that needs a plan change, such as a contract flaw, goes to the
Project manager instead. The Project manager either sends it to the build
team, or works it through in a planning meeting first.

## Verification methods

The Analyst gives each acceptance criterion one verification method, and the
owner approves the methods with the spec:

- **Test:** an automated test.
- **UI check:** the Test engineer runs the app in the box with a headless
  browser and asserts on the page state. It attaches screenshots for the
  owner. A model judges a screenshot against the UI designer's spec only when
  the build plan opts in.
- **Owner check:** a manual item on the pull request's checklist.

## Release ready

A milestone or build is release ready when all of the following hold:

- Every test and UI check criterion has at least one passing check, which the
  engine verifies by tracing criteria IDs to tests. Each of those tests
  passed the red check.
- The full test suite, type checks, and lint pass, apart from known failures.
- The review pipeline reports the diff clean.
- CI passes after push. A Copilot pull request review runs only when the
  build opts in, and it never blocks.
- The docs, the changelog entry, the version bump, and the pull request
  description are written, with owner checks listed.

The pipeline never merges. After the owner merges, the Project manager tags
and releases with the `release-versioning` skill, but only when the owner
tells it to.

## Escalations

An escalation is a decision that execution can't make inside the build plan's
bounds. It works as follows:

- The engine pauses the affected task and its dependents. Independent tasks
  continue.
- The escalation goes to the Project manager, which resolves anything inside
  the plan: retries, task order, seating on-call roles, and clarifications
  that the plan already implies.
- After a planning meeting, the Project manager can approve a change to
  contracts or architecture. The Scribe records that change as a decision,
  with the meeting linked.
- A change to acceptance criteria, scope, or milestones goes to the owner. The
  owner decides alone or with the planning team, and the Project manager then
  directs the build team.

The following conditions escalate:

- A task that reaches its attempt cap.
- Oscillation, which is a test that a later task breaks after an earlier task
  made it pass.
- A milestone review that reaches its round cap.
- A Developer that needs to change a contract.
- A missing secret or external service. An agent never works around the gap,
  for example with a mock that ships.

## Boxes and lifecycle

A build runs in one box, next to the Project manager's session. Each box runs
at most one active build, and stand-alone review runs can run beside it. For
parallel builds on one project, use another box.

When the box stops, the build pauses. It resumes when the box starts. The
Project manager is the box's main session, and the engine delivers
escalations and digests into it as messages. Each delivery is a one-line
pointer to the file, typed into the session.

The Project manager's session can run for days and compact many times, so it
doesn't hold the build in its context. The engine keeps the build's state in
a `STATUS.md` file in the `.aio/builds/SLUG/` directory, and the `aio-build`
skill has the Project manager reread that file and the build plan after a
compaction or a restart. Every escalation and digest is also a file. When the
session doesn't wake on a message, the escalation waits in the Builds area,
and the app notifies the owner.

When the owner cancels a build, the engine stops every agent and keeps every
branch and worktree. The Scribe writes a closing record of what got done,
what was learned, and why the build stopped. The build stays resumable until
the owner deletes it. Deleting it removes the internal branches and worktrees
and keeps the record.

## Secrets

During planning, the Analyst lists every secret and external service the
build needs, and the owner ticks those secrets for the project before
approval. Secrets belong to a project, not to one box. During execution, agents get secrets only through the `aio-secret`
command.

## Record

The repository is the canonical record. The Scribe promotes durable records
into committed files in each pull request:

- ADRs in the `docs/adr/` directory.
- The `GLOSSARY.md` file.
- The architecture doc.
- A codebase walkthrough, updated in each pull request.

The build plan stays as working state in the `.aio/builds/SLUG/` directory,
which Git ignores. A memory sink interface copies each record to the owner's
memory archive. The Librarian reads the archive through its tools. The sink lets the archive live inside
AI Orchestrator or stay a local add-on without a design change.

## Usage watcher

Builds have no quota budgets. Instead, an account-wide watcher in AI
Orchestrator covers builds and stand-alone review runs:

- **Ceiling alert:** the watcher alerts when a 5-hour window passes 80%, but
  only when the current burn rate reaches 100% before the window resets.
- **Burn alarm:** the watcher alerts on an abnormal jump, such as more than
  15% of a window in 10 minutes.
- **7-day window:** the same two rules, with thresholds that the owner sets.

Stand-alone review runs keep their usage ceilings, which pause and redirect
calls. Build calls are exempt from the ceilings. The watcher reads the usage
of one machine and doesn't combine machines.

Alerts go to the desktop and to the Project manager. The owner tells the
Project manager to pause or continue. Nothing pauses on its own, except when a
vendor actually hits its limit, in which case the engine waits for the reset.
The Project manager's milestone digests report the usage each milestone
spent.

The engine attributes usage to each seat and each milestone loop step, so the
owner can see which seats earn their cost. The Analyst's size estimate
includes an expected usage range, and the watcher alerts when a build passes
twice that estimate.

## App

The Boxes app gets a Builds area beside the box list. A box that runs a build
shows a badge that links to the build. The Builds area shows the messages as a conversation, with filters by task, milestone, and
seat. It also shows the direct messages, a milestone board, the usage by
seat, and a box for the owner's posts. Usage watcher alerts appear across the
whole app.

## Delivery phases

The pipeline ships in two phases, so that evidence from real builds decides
what the default flow includes.

### Phase 1

Phase 1 is the smallest flow that carries the mechanisms with the most effect
on quality:

- Planning with the Project manager, the Analyst, the Architect, and one
  Critic meeting.
- The build plan, with acceptance criteria and verification methods.
- Tasks that run one at a time, in dependency order.
- Tests first on a different vendor from the Developer, with the red check,
  the coverage check, the test lock, and test disputes.
- Preflight, the task gate, and the Debugger.
- One review pipeline run for each pull request, in single PR mode.
- Messages as files, with direct addressing, owner posts, and session resume.
- Escalations.
- The Scribe as one step before each pull request.
- Usage by seat and by step.
- A Builds area with the message view, the milestone board, and the box for
  owner posts.

### Measurement

After phase 1 works, run the same three tasks two ways: through the build
pipeline, and through a baseline of one top-tier Claude Code session followed
by the review pipeline. Use one bug fix and two medium builds. Compare the
following:

- The usage, in total and by seat.
- The confirmed findings in the final review.
- The acceptance criteria that the result meets.
- The corrections that the owner asks for after the pull request.

### Phase 2

Each of the following joins the default flow only when the measurements show
a gap that it closes:

- Parallel Developers, with owned file set enforcement.
- The Harden and Simplify steps.
- A review pipeline run for each milestone in single PR mode.
- The bench roles, and the on-call roles other than the Debugger.
- The Librarian as a seat during execution.
- Channels and side chats.
- The release train, and with it large builds.
- The memory sink.

## Fit with AI Orchestrator

The following sections describe how the build pipeline sits on the parts of
AI Orchestrator that predate it.

### Engine

The build state machine runs in the `aio-engine` process, beside the review
state machine. Both use one shared core for agent calls: leases, tiers, the
limit fallback, the call cache, and events. For the reasons, see the
`docs/adr/0007-builds-run-in-the-review-engine.md` file.

The Project manager reaches the engine with the `aio-build` command, which
the image ships like the `aio-secret` command. The command talks to the
engine over a local socket that accepts only build requests: call a planning
seat, run a meeting, freeze the build plan, start, pause, read the status,
and post. The planning team runs as engine calls under leases, so planning
usage counts by seat.

The server copies the `aio-build` skill from the installed package into each
Claude account at start. The skill refuses to run in a Codex or Copilot box.

### Code and files

A build keeps its state in the `PROJECT_ROOT/.aio/builds/SLUG/` directory,
beside the `.aio/runs/` directory. Replace `PROJECT_ROOT` with the project's
primary checkout. Role overrides in the `.aio/team/` directory are local,
because Git ignores the `.aio/` directory.

In phase 1, a build works in one build worktree under the `.worktrees/`
directory. Tasks, the task gate, and the review run all use that worktree,
and the Project manager's own checkout stays untouched. A worktree for each
task arrives with parallel Developers.

The build plan holds its own test, type check, and lint commands, which the
Project manager seeds from the policy file.

### Review pipeline

A build starts its review run without a box ID, so the Project manager's
session gets no hold-edits message. A review decision inside that run becomes
a build escalation. A Copilot review is an option of every review run, in a
build or stand-alone, and no run requires one.

Review lenses need a focus-area option in the review pipeline. That option
arrives in phase 2, with the roles that use it.

### Team chat

The team chat MCP server is one HTTP endpoint in the engine process. Each
agent gets its own token, so the engine knows the sender. The engine attaches
the server to one agent call only, and attaches it again on every resume:

- **Claude Code:** the `--mcp-config` and `--strict-mcp-config` flags, with
  the bus tools in the `--allowedTools` flag.
- **Codex:** a `-c mcp_servers.NAME.url=URL` override on the `codex exec`
  and `codex exec resume` commands.

### Permissions

A role definition declares one of two permissions: read-only, or a list of
writable path globs. The engine enforces the permission itself. After each
agent turn, it compares the worktree with the role's paths and rejects a turn
that changed anything else. Claude seats also get the matching tool flags.
Codex runs with full access inside the container, so for a Codex seat the
engine detects a violation after the turn and can't prevent it.

### Session resume

The size rule uses a cache window for each vendor, set in configuration. The
defaults are 60 minutes for Claude and 30 minutes for Codex. A placement
change starts a fresh agent, because a different model or effort invalidates
the cache.

### Limits and usage

When a vendor hits its limit during a build, the engine waits for the reset.
It doesn't redirect the call to another vendor, so the rules that require a
different vendor keep holding.

The Project manager's session makes no engine calls. The engine reads that
seat's usage from the session's transcript at each digest, as tokens only.

## Open questions

- Whether a live Codex session loads an MCP server from a `-c` override, and
  how Codex approves MCP tool calls without a terminal.
- How long the Codex prompt cache lasts in practice.
- Which project traits the engine can detect reliably for bench seating.
- Scaffolding for greenfield projects, which follows support for repositories
  that already exist.
