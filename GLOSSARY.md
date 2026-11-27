# AI Orchestrator

AI Orchestrator (aio, also written ai-o) runs coding agents in Docker containers and manages them from
a host server, desktop apps, and a CLI.

## Install and update

**Upgrade**:
Moving the host to a different AI Orchestrator version: the server, the apps,
the image with the latest agent CLIs, and every project container, all at
once. Open sessions and runs stop, as with any package upgrade, and come
back afterward.
_Avoid_: Update, deploy, rebuild

**CLI update**:
Rebuilding the image with the latest agent CLIs (Claude Code, Codex,
Copilot) without changing the AI Orchestrator version.
_Avoid_: Image rebuild, Claude Code update

**State adaptation**:
One step that moves a saved review run from one state version to the next,
so a run saved by an older version can resume.
_Avoid_: Migration (reserved for the server database), upgrade step

**Project container**:
The one container that holds every box and review run of a project.
_Avoid_: Box container, agent container

## Accounts

**Account**:
One sign-in to one agent vendor, with its own folder under
`~/.ai-orchestrator/accounts/VENDOR/NAME` that holds everything that vendor's
CLI uses: sign-in, settings, skills, plugins, and instructions. Boxes and
`aio` commands use the account folder and never the host user's own vendor
folders.
_Avoid_: Profile, config dir, home

**Global instructions**:
The owner's working rules that apply to every account, kept in one
`AGENTS.md` at the top of the accounts folder.
_Avoid_: Global CLAUDE.md, user memory

**Account instructions**:
The rules for one account only, kept in that account's own `AGENTS.md`.
They add to the global instructions and can be stricter, such as a work
account that never touches GitHub.
_Avoid_: Profile rules

**Include line**:
A line `@path` in an instructions file that pulls in another file, such as
another account's instructions. Claude Code follows it itself; AI
Orchestrator expands it for Codex and Copilot.
_Avoid_: Link, symlink, import (for the file-level mechanism)

## Review runs

**Named base**:
The commit the owner asks a review run to compare against, such as the tip
of `main` when the run starts.
_Avoid_: Base (on its own)

**Change base**:
The commit a round's diff starts from: where the branch left the named
base in round 1, or the tip before the last fix in a round that reviews
only the fix.
_Avoid_: Base (on its own), diff base

**Branch point**:
The commit a change grew from: where the branch left the named base, or
the named base itself when the owner asks for an exact base. A finding
counts as introduced when its flaw is absent at the branch point.
_Avoid_: Base (on its own), merge base (for the concept)

**Review range**:
What one round of a review run looks at: its change base, its tip, and the
files that changed between them.
_Avoid_: Range (on its own), diff

## Build pipeline

The build pipeline takes a request from planning to a release-ready pull
request, using a team of role-based agents. It is a sister to the review
pipeline inside AI Orchestrator.

### Team

**Role**:
A reusable definition of one job on the team, such as Architect, with its
prompt, rules, permissions, triggers, and output contract. A review run's
reviewer, disprover, confirmer, and fixer are review roles, a separate set.
_Avoid_: Agent type, persona

**Specialty**:
A named pack of guidance for one technology, such as Node.js or Go, that a
task gives to the agents that work on it. A role sets the job and its rules,
and a specialty adds knowledge of the technology.
_Avoid_: Specialist role, skill (for the build concept), stack agent

**Seat**:
A role that a build activates.
_Avoid_: Slot, assignment

**Agent**:
One model session that fills a seat for one piece of work. One seat can hold
several agents at once.
_Avoid_: Worker, bot

**Team**:
The set of seats in one build.
_Avoid_: Crew, squad

**Planning team**:
The seats that shape the build plan: Analyst, Architect, Critic, and the
design consults.
_Avoid_: Design team

**Build team**:
The seats that carry out the build plan: Test engineer, Developers,
Simplifier, the bench roles, and the on-call roles.
_Avoid_: Dev team, execution team

**Project manager**:
The core role that is the owner's single point of contact. It runs planning,
triages escalations, and directs the build team. The owner's main Claude
conversation fills this seat.
_Avoid_: PM, lead, orchestrator

**Analyst**:
The core role that turns a request into a spec: stories, edge cases,
acceptance criteria, and a size estimate.
_Avoid_: Product manager, PM, scope estimator

**Core team**:
The roles that every build seats.
_Avoid_: Tier 1, primary group

**Bench**:
The roles that a build seats because of the project's traits, such as having
a user interface or a database.
_Avoid_: Tier 2, project bench

**On-call role**:
A role that the engine activates only when one of its triggers fires, as a
seat or as a review lens.
_Avoid_: Tier 3, situational role

**Scribe**:
The core role that writes the project's record: decisions and their reasons,
the glossary, the architecture, and the codebase walkthrough.
_Avoid_: Note taker, secretary

**Librarian**:
The core role that reads the project's record and the code to answer
questions and to give other agents the context they need.
_Avoid_: SME, context librarian, historian

**Memory archive**:
The owner's long-term, cross-project store of records, which receives copies
of each project's record. The repository stays the canonical record.
_Avoid_: Wiki, knowledge base

**Design consult**:
Constraints that a specialist role adds to the spec before any code exists.

**Review lens**:
A focus area that a specialist role adds to the review pipeline's reviewers.
_Avoid_: Review stage, audit

### Lifecycle

**Build**:
One whole effort, from the first planning conversation to the final
release-ready pull request.
_Avoid_: Run, job, project

**Planning**:
The interactive phase of a build, a conversation between the owner and a
Claude Code session that produces the build plan.
_Avoid_: Intake, design phase

**Build plan**:
The approved, versioned record of what a build delivers and how: the spec,
acceptance criteria, architecture, contracts, milestones, and task graph.
_Avoid_: Spec, PRD, ticket

**Flow**:
How a build runs after planning: as a pipeline build through the build
team, or through the single-session flow. The Analyst recommends one, and
the owner chooses before the freeze.
_Avoid_: Mode, track

**Single-session flow**:
The flow in which one Developer session works the approved acceptance
criteria, one review run checks the result, and the same session fixes the
confirmed findings. The recommended flow for a small or medium task that
isn't high-risk.
_Avoid_: Baseline (for the flow), solo mode

**Defaulted answer**:
A planning question that the Project manager answers with the Analyst's
recommended answer instead of asking the owner, because no answer would
change an acceptance criterion. The build plan lists each one.
_Avoid_: Assumption, default

**High-risk task**:
A task that changes stored data, runs a migration, or crosses an account or
security boundary across several packages. The Analyst flags it, and
recommends the pipeline for it whatever its size.
_Avoid_: Risky task, critical task

**Execution**:
The unattended phase of a build, in which the engine carries out the build
plan.
_Avoid_: Build phase, coding phase

**Milestone**:
A working, tested increment of a build. Every build has at least one.
_Avoid_: Phase, sprint, stage

**Single PR**:
The delivery mode in which all milestones land on one branch and reach the
owner as one pull request.

**Release train**:
The delivery mode in which each milestone reaches the owner as its own pull
request.
_Avoid_: Stacked mode

**Release ready**:
The state of a milestone or build that meets every exit criterion and waits
only for the owner to merge it.
_Avoid_: Done, complete, shippable

**Context pack**:
What a task's agent gets in its prompt so that it doesn't survey the
repository: the task's excerpt of the build plan, its acceptance criteria,
and the contents of its contract and owned files. Code assembles it when the
task starts, and every attempt at the task reuses it.
_Avoid_: Brief, task bundle

**Escalation**:
A decision that execution can't make inside the build plan's bounds. It goes
to the Project manager, and on to the owner when it changes what the build
delivers.
_Avoid_: Blocker, ticket, alert

**Engine defect note**:
The note that the Project manager writes, through a resolution with the
`engine defect` cause, when a defect in the engine raised an escalation. The
build pauses, and a separate session fixes the engine from the note.
_Avoid_: Bug report, engine fix

### Team chat

**Team chat**:
The messages that a build's agents and the owner exchange, shown as a
conversation. Each message is a file, and the owner can read all of them.
_Avoid_: Slack, log

**Message**:
One typed file that a sender addresses to a seat or to the owner, such as a
question, a test dispute, a file request, or a meeting reply. The engine
delivers it straight to the addressee.
_Avoid_: Chat message, note

**Owner post**:
A message from the owner to one agent. The engine records it as a decision.
_Avoid_: Comment, instruction

**Channel**:
A topic space in the team chat, such as one per milestone or design question,
that only its members read. A phase 2 addition.
_Avoid_: Room, topic

**Side chat**:
A private conversation between two or more agents in the team chat. The owner
can read it. A phase 2 addition.
_Avoid_: Agent DM, back channel

**Direct message**:
A message from an agent straight to the owner, outside the Project manager.
_Avoid_: DM, side chat, escalation

**Slice**:
The messages that one agent received. The owner can view each agent's
slice.
_Avoid_: Inbox, feed, context

**Meeting**:
A turn-based discussion of one proposal, which ends when no
invited role holds a major objection, when the meeting reaches its round
cap, or when the Project manager ends it early.
_Avoid_: Discussion, standup, review

### Testing

**Contracts step**:
The step before tests first in a medium or large build. A Developer writes
the plan's contract files, with stubs, so the tests compile against the real
signatures.
_Avoid_: Contracts task, scaffolding

**Red check**:
The engine's run of the tests before the code exists. Each test must fail on
an assertion.
_Avoid_: Dry run, smoke test

**Coverage check**:
One reading of each acceptance criterion with its tests, by an agent on a
different vendor from the Test engineer, to find criteria that the tests
don't check.
_Avoid_: Test review, audit

**Test lock**:
The engine's record of each test file's hash. The gate fails a Developer
commit that changes a locked file.
_Avoid_: Freeze, protection

**Test dispute**:
A message from a Developer that says a locked test is wrong, with the reason.
It goes to the Test engineer.
_Avoid_: Test escalation, appeal

**Setup command**:
A build plan command that makes the fresh build worktree ready, such as a
dependency install. Preflight runs each one once, before every other
command, in the test commands' environment. Agents never install
dependencies themselves.
_Avoid_: Install step, bootstrap

**Known failing**:
A test that fails in every preflight run. It doesn't block the build.
_Avoid_: Broken test, expected failure

**Flaky**:
A test whose result differs between runs of the same code. The engine
quarantines it.
_Avoid_: Unstable, intermittent

**Failure fingerprint**:
The set of failing checks in one gate run, each with its normalized first
error line. Two gate failures in a row on one failure fingerprint seat the
Debugger.
_Avoid_: Error signature, failure hash

**Owned file set**:
The files that one task can change.
_Avoid_: Scope, file list

**Task**:
The smallest unit of work in a build plan, sized for one agent session, with
an owned file set and the tests that it must make pass.
_Avoid_: Ticket, job, step

**Task gate**:
The checks that the engine runs after each Developer attempt on a task: the
tests, type checks, lint, the test lock, and the owned file set.
_Avoid_: Gate (on its own, which is the review pipeline's check after a fix)

### Placement

**Placement**:
The vendor, model tier, and effort that a seat runs on.
_Avoid_: Profile, assignment

**Single-vendor setting**:
A build setting that places every seat on one vendor. A rule that requires
another vendor then uses a fresh agent on the same vendor.
_Avoid_: Single-vendor profile, `claude-only`, `codex-only`
