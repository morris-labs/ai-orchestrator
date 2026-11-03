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

## Depth

A run's depth sets how much it spends looking for problems. You pick it when a
run starts, in the **Depth** dropdown of the run launcher, or with `--depth`:

```bash
aio review start --box BOX_ID --depth thorough

```

Replace `BOX_ID` with the box whose branch you want to review. The run view and
`aio review status RUN_ID` show the depth. A run from before depths existed has
no `depth` field and stays `thorough`.

| Setting | `standard` (default) | `thorough` |
|---|---|---|
| Reviewer asks for | P1 and P2 only | Every plausible issue |
| Reviewer passes | One per group, with no follow-up or continuation | Two on major groups, with ledger follow-ups and continuations |
| Group size limit | 1500 changed lines, with groups joined by feature | 400 changed lines, with no joining |
| Disprover | One call per batch | One call per finding |
| Tiers in **Auto** | Medium; large for risk paths; small for docs only | The signals in [How a group gets its tier](#how-a-group-gets-its-tier) |
| Round cap | 2 | 25 |
| Rounds after the first | Review only what changed since the last review | Review the whole range |
| Clean | One round confirms nothing above `nit` | Two rounds in a row |
| Verification floor | `P2` | None |

Settings you name win over the depth: `--round-cap`, `--continuation-cap`,
`--verify-floor`, `--tier`, `--role`, and `groupSizeLimit` in the policy file. To
check every severity at `standard`, pass `--verify-floor all`, which the request
stores as the `nit` floor. A post-push request keeps the cap of 25 unless you
name one. A pre-push run that continues after `aio review push` gets a separate cap
of 25 for its post-push rounds, whatever its pre-push cap was. A policy file that
doesn't name `groupSizeLimit` uses the limit of the depth, and the policy editor
doesn't write the key when the value is the default of 400.

### Reviewers at the standard depth

A `standard` reviewer reports only bugs that break real use and security flaws
that are easy to exploit, the kind an unskilled attacker could use with a public
script or simple tampering: missing auth checks, injection from outside input,
path traversal, leaked or logged secrets, unsafe defaults, and exposed ports
without auth. It assumes a trusted owner and trusted machines, and doesn't
construct targeted attack chains, compromised-node or hostile-container scenarios,
or exploit scripts. There is no cap on the number of findings.

Each group gets one reviewer, in turn among the role's vendors. Copilot reviews
the whole diff only when it is the only reviewer or you named it with `--role`.
A reviewer that reports a P3 or a `nit` anyway gets the ordinary
[verification floor](#verification-floor) treatment.

### Groups at the standard depth

The engine first groups each file with its tests and matched docs, then joins
neighboring groups of one feature area while they fit the limit. The area is the
first two folders of the path, without `src`, `lib`, and test folders. Docs-only
groups and risk-path groups join only their own kind, so the first keep the small
tier and the second don't raise other code to the large tier.

### Batched verification

A `standard` disprover checks all of a group's pending findings in one call and
returns a verdict for each finding ID, so the same code isn't read once per
finding. The batches work as follows:

- **Partitions**: one batch per group, disprover vendor, and reporter vendor, so
  the cross-vendor rule holds for every member.
- **Size**: a batch splits only when its finding text and expected verdicts pass
  40,000 estimated tokens. It never splits on the number of findings.
- **Duplicates**: a finding with the root cause of another, by the merge's test or
  by close text in one file, stays out of the prompt and takes the other's verdict.
- **Missing verdicts**: a finding with no verdict stays pending, and the next round
  checks it.
- **Resume**: the stage saves its batch plan before any call, and each call's key
  comes from the planned finding IDs, so a saved call still answers after a restart.
- **Scripts**: a verdict can name a reproduction script, which the engine reruns
  for that finding at the tip and the base.
- **Effort**: a batch call asks for medium reasoning effort, and high from 5
  findings, because many checks share one call. Claude and Codex calls take the
  setting, and the log and the tier reason record it. Copilot calls don't.
- **Refusals**: a refused batch goes through the fallback in
  [Retry a failed run](#retry-a-failed-run). If nothing answers, each of its
  findings tries alone before the engine flags it, so one finding can't flag a whole
  group.

A `thorough` run makes one call per finding.

### Compact findings

At `standard`, agents write findings for other agents. The prompts ask for a
title that is a short claim of at most 80 characters, a failure case in the form
`input > wrong result` of at most 160, and evidence of `file:line` and a minimal
fact of at most 200. Reasons are at most 100 characters. These limits are
guidance in the prompts. The engine doesn't cut a field that decides a verdict,
and it cuts only the copy of the evidence that a fixer reads, at 400 characters.

Later agents also read less. A disprover gets the severity, location, title, and
failure case. A confirmer gets the location, title, and failure case. The apps
show the stored fields as they do at `thorough`, in shorter form.

### Rounds at the standard depth

Round 1 reviews the branch and fixes what the disprover confirms. If it confirms
nothing, the run stops. Round 2 reviews only the fixer's diff, not the whole
branch, verifies what is still pending, and can stop clean. When the fixer changed
nothing, round 2 makes no reviewer call.

### Estimate the tokens of a run

**Preview groups** in the run launcher shows a rough token estimate for the chosen
depth. Code computes it from the changed lines and the group count, with no model
call, using the `TOKEN_ESTIMATE` figures in `packages/contracts/src/runs.ts`. The
`thorough` figures start from one real run of about 140 million tokens over 107
groups. The `standard` figures are planning guesses until runs measure them. The
number of findings moves the real figure the most, and the estimate can't see it.

The estimate works the same way for a whole-project run, where every line in a
reviewed file counts as changed, so expect a large number.

## Vendors and roles

Claude writes and fixes all code. The other roles move between vendors
according to the profile and the usage ceilings.

| Vendor | CLI | Roles |
|---|---|---|
| Claude | `claude -p` | Fixer, always. Reviewer and disprover when the profile allows. |
| Codex | `codex exec` | Reviewer, disprover, and fix confirmer. |
| GitHub Copilot | `copilot -p`, with automatic model selection | Reviewer. Disprover of Codex findings in `offload`. Pull request reviewer after the push. |

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
run view, or run `aio review profile RUN_ID PROFILE`. A profile switch applies
from the next round. To move a role to another vendor, run
`aio review assign RUN_ID ROLE VENDOR`. An assignment applies at once to every
call of that role that hasn't started, including one waiting out a ceiling. A
later assignment of the same role replaces an earlier one, and a continuation
of a review stays with the vendor that holds its session.

### Choose roles when a run starts

To start a run with other vendors than the profile gives, change the roles
in the **Profile and roles** section of the run launcher. The role table
starts from the selected profile's round 1 roles and follows the profile
when you switch it, until you change a role. After that, a profile switch
keeps your changes; to drop them, click **Reset to profile defaults**. The
`reviewer` row takes one or more vendors, and every other row takes one.

From a terminal, pass `--role` to `aio review start` once for each role:

```bash
aio review start --box BOX_ID --role reviewer=codex,copilot --role confirmer=copilot
```

Replace `BOX_ID` with the box whose branch you want to review.

A run request carries only the roles you changed, in its `roles` field. Those roles hold from round 1, like roles you
assign with `aio review assign`; the roles you leave alone follow the
profile from round to round. The engine refuses a role for a vendor with no
adapter in the container, and the request schema refuses more than one
vendor for any role but `reviewer`. Switching the profile of the running
run drops the starting roles and every assigned role, and the run takes the
new profile's roles from the next round.

## Model tiers

A tier sets how strong a model each call uses. The profile picks the vendors;
the tier picks the model on each vendor. In **Auto**, the default, code in the
engine chooses the tier for each group and role, with no model call. To fix
one tier for a whole run, use the **Model tier** section of the run launcher,
or pass `--tier` to `aio review start`:

```bash
aio review start --box BOX_ID --tier medium
```

Replace `BOX_ID` with the box whose branch you want to review. The values are
`auto`, `small`, `medium`, and `large`.

### How a group gets its tier

Each changed file asks for a tier, and the group takes the strongest. The
first row that matches a file decides:

| Signal | Tier |
|---|---|
| A `tierPaths` rule in the policy file matches | The rule's tier |
| A risk path matches | Large |
| A documentation file or a lockfile, by path | Small, whatever the size |
| An exported API changes, and a changed symbol appears in 3 or more other files | Large |
| A schema changes | Large |
| A changed symbol appears in 10 or more other files | Large |
| The changed code involves concurrency, migrations, or parsing | Large |
| Any other code | Medium |

Changed symbols come from `git diff -W` and per-language patterns for
TypeScript, JavaScript, Python, Go, Java, C, C++, and shell. Other languages
skip this signal. `git grep -l -w` counts the files at the tip that hold each
symbol. The count leaves out the file itself, its tests, documentation,
lockfiles, build output, and data files, and it skips names under four
characters and common words. The counts of one round have a 15-second limit;
after that, the other signals decide, an exported change stays large, and the
reason says so. These signals only raise a tier.

### How a role changes the tier

| Role | Tier |
|---|---|
| Reviewer | The group's tier |
| Disprover, confirmer | One tier up, at medium or above |
| Fixer | The group's tier, at medium or above |
| Sweeper | The group's tier, at medium at most |

At the `standard` depth, none of these moves up apply: a call takes its group's
tier, a fixer stays at medium or above, a confirmer takes the built-in large model even when `tierModels` lowers that tier, a sweeper stays at medium or
below, and a disprover on a docs-only group can use the small tier. A malformed
answer still retries one tier up.

A call moves one more tier up when its files have findings that persist from
an earlier round, and when the retry follows a malformed answer. A fixed tier
turns off these moves and applies to every role, except that disprovers,
confirmers, and fixers stay at medium or above.

Code never runs below medium. A fixed `small` tier or a `tierPaths` rule gives
a group that holds code the medium tier. Only files that are documentation or
lockfiles by path can get the small tier: Markdown, reStructuredText, and
AsciiDoc files, `README` and `LICENSE` style names, and known lockfiles. A
comment or formatting change in a code file counts as code. So do MDX files,
other text files, and Markdown that instructs an agent, such as `CLAUDE.md`,
`AGENTS.md`, `SKILL.md`, `*.prompt.md`, and files under `prompts`, `skills`,
`.claude`, or `.github` folders. A file renamed from code to a documentation
name also counts as code. A lockfile stays small even when it changes a
dependency's source; to review lockfiles more closely, add them to `riskPaths`
or `tierPaths` in the policy file.

The run view lists each group's tier and reason. Each `agent.started` event
carries the call's tier and reason, and the engine logs each choice.

### Tier mappings

The built-in mappings are the following:

| Vendor | Small | Medium | Large |
|---|---|---|---|
| Claude | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` |
| Codex | `gpt-6-luna` | `gpt-6.1-terra` | `gpt-6.1-sol` |

GitHub Copilot has no mapping and keeps its automatic model selection
(`--model auto`). To change a mapping, set `tierModels` in the
[policy file](policy.md).

### Blocked models

Review runs never use a Claude model whose name contains `fable`, or a Codex
model whose name contains `astra`, in any letter case. The
`BLOCKED_REVIEW_MODELS` list in `packages/contracts/src/tiers.ts` holds these
names. The engine enforces the rule in the following places:

- The policy schema refuses a blocked name in `tierModels`, with an error that
  names the model.
- The engine refuses a blocked name in its per-vendor model setting.
- Each call checks its model before it starts, and the adapter bridge checks
  again before it runs a CLI.
- A Claude or Codex call with no other model passes `claude-opus-5-5` or
  `gpt-6.1-sol`, so it never falls through to the CLI's default.
- After a call, the run fails if the CLI reports a blocked model. This backstop
  catches an alias that resolves to a blocked model. For Codex, the report
  comes from the session's rollout file.

The rule doesn't cover GitHub Copilot: it has no block list, and its automatic
selection chooses the model.

## Accounts

In accounts mode, each model call of a run uses its vendor's default
account: the engine sets `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or
`COPILOT_HOME` to the account folder that the server names in the
read-only `/run/aio-config/account-dirs.json` file. A change of default applies
from the next call that starts a session, within what the container mounts. In host mode, the CLIs use the container user's `~/.claude`,
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
disprove roles to the next vendor that can take them. Codex and Copilot can
review and disprove, Claude can review and disprove, and only Codex confirms.
The fixer stays with its vendor: when that vendor passes its ceiling, the run
pauses until the window resets and notifies you. You can change the ceilings
in the settings, and override them per project.

### When a vendor reports a limit

A vendor's CLI can report a usage or rate limit that the ceilings didn't
predict, such as a monthly quota. A limit never fails a run. The engine
remembers the vendor for the rest of the run, sends it no more calls, and tells
the server not to move calls to it. Calls already under way can still report
the same limit, so a vendor gets at most one call per parallel worker, not one
per finding.

The engine then acts in the following order:

1. It moves the call to another vendor that can take the role. The cross-vendor
   rule holds: a disprover is never the finding's reporter, and a confirmer is
   never the fixer. The fixer and a reviewer's continuation never move.
1. With no such vendor, and a reset time for the vendor or any other candidate,
   the run pauses until the earliest reset. The server's ceiling answer can also
   set this time.
1. With no reset time known, such as for a monthly quota message, the run stops
   with a `ceiling` decision. To go on, assign the role to another vendor or fix
   the vendor's quota, then resume.

A rate limit with no reset time blocks its vendor for 15 minutes. When you
resume or retry a run, the engine forgets the limits it remembers, and when you
assign a role to a vendor, it forgets that vendor's limit. If the vendor is
still at its limit, its next call reports that, and the steps start again.

### Clear a stale usage block

A stored sample counts until its reset time. If you buy a reset, the sample
still says the vendor is over its ceiling, and a blocked vendor gets no call
that could report the new figure. To clear the block, select **Clear block**
in the **Model usage** panel, or run the following command:

```bash
aio review clear-usage VENDOR

```

Replace `VENDOR` with `claude`, `codex`, or `copilot`. To clear one account,
add `--account VENDOR/NAME`. The vendor's next real sample replaces the cleared
reading. A run waiting on the ceiling asks the server again every minute, so it
continues on its own. A run waiting after the vendor's CLI reported a limit
keeps waiting for the reported reset time, or for a decision, until you resume
it:

```bash
aio review resume RUN_ID

```

Replace `RUN_ID` with the run's ID.

To see each vendor's usage, ceiling, and reset time, open the usage view or
run `aio review usage`.

The **Model usage** panel on the **Usage** tab of the Boxes app shows one line
for each window that a vendor's CLI reports:

- **Claude**: the 5-hour block and the weekly window.
- **Codex**: the 5-hour block and the weekly window.
- **GitHub Copilot**: none. The output that the engine reads has no usage windows.

No vendor reports a monthly window through its CLI. A monthly line appears only
when a stored sample has that window.

The engine records samples from every review call that reports them, including
calls that fail or hit a limit, so a figure can be older than your last call
only when that call reported nothing. Each line shows the age of its sample.
After a window's reset time passes, its line shows **No recent data** instead
of a percentage, until a later call records a sample. `aio review usage` lists
the same windows, and shows `reset` for a window whose reset time has passed.

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

### Review the whole project

To review what ships at a tip instead of a change, select **Whole project** in
the launcher, or pass `--whole-project` to the `aio review start` command:

```bash
aio review start --box BOX_ID --whole-project --read-only --tip origin/main

```

Replace `BOX_ID` with the box to review. The tip works as usual, and a read-only
run can take a remote branch or a commit. The launcher selects read-only when you
choose the scope, and you can clear it to allow fixes. A whole-project run can't
use the post-push pipeline.

A whole-project run behaves differently in the following ways:

- **Base**: the engine ignores the base and diffs from a commit of Git's empty
  tree. The commit has fixed names and dates, so it needs no Git identity and
  always has the same SHA. No branch or tag points at it. If a garbage collection
  removes it, the engine recreates it when the run resumes or opens a round.
- **Findings**: every finding counts as introduced. The engine makes no base
  checkout, runs reproduction scripts at the tip only, and never labels a finding
  `pre-existing`.
- **Rounds**: round 1 reviews the project, in file groups only, and later rounds
  review only the fixer's diff, at both depths. Copilot takes groups instead of a
  whole-diff call, and a sweep searches the checkout instead of reading a diff.
- **Tiers**: at the `thorough` depth, `auto` skips the function diff and reference
  counts in round 1, because every symbol changed.
- **Exclusions**: the built-in list applies, as the next section describes.

### Exclude paths

Excluded files never join a group, at any scope. A file is excluded when it
matches one of the following lists:

- The `excludePaths` globs in the [policy file](policy.md).
- The globs for the run: **Exclude paths** in the launcher, or `--exclude` on the
  `aio review start` command.
- In a whole-project run only, the built-in list: lockfiles, `*.min.js`, `*.min.css`,
  `*.map`, `*.pb.go`, `*_pb2.py`, `*.generated.*`, and anything under a `dist`,
  `vendor`, `node_modules`, `third_party`, or `__generated__` folder.

The preview shows the number of excluded files. Expand **Excluded files** to see
each file and the list that excludes it, for up to 1,000 files.

## Pre-push stages

Each round of a pre-push run goes through the following stages. The list
describes the `thorough` [depth](#depth), and the `standard` depth changes some
of them.

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

## Verification floor

To limit how many findings go to a disprover, set a verification floor. The
floor is the lowest severity that a disprover checks. The severities, from the
strongest, are `P1`, `P2`, `P3`, and `nit`. No severity ranks above `P1`. With
no floor, a disprover checks every severity. The `standard` [depth](#depth) sets a
floor of `P2` unless you name another.

Set the floor in the **Verification** section of the run launcher, or pass
`--verify-floor` to `aio review start`:

```bash
aio review start --box BOX_ID --verify-floor P2

```

Replace `BOX_ID` with the box whose branch you want to review.

Findings below the floor behave as follows:

- They stay `pending` and stay listed. The Findings screen and
  `aio review findings` label them as not verified because of the floor, and the
  finding carries `unverifiedReason: below_verify_floor`.
- They never count as confirmed and never go to the fixer or the sweep.
- They don't hold a run open. The clean test ignores them, so a run can finish.
- They keep a run from reporting `clean`. Where a run would stop clean, it stops
  with `clean_above_floor` instead, and you get the ordinary **Run finished**
  notification, not **Branch is ready to push**. You can still push the run.
- Every finish with such findings, for any stop reason, adds a notice with their
  count to the run.

A confirmed finding below the floor also stays away from the fixer and the sweep,
even when a disprover confirmed it before a retry set the floor. It stays
`confirmed` and listed, with a label that says the floor kept it from the fixer
(`fixHeldReason: below_verify_floor`), and it makes the run stop with
`clean_above_floor` instead of `clean`. A fix that already exists still goes to
the confirmer. A confirmed `nit` never goes to the fixer, with or without a
floor, so it gets no label. To send held findings to the fixer again, retry with
`--verify-floor all`, or with a lower floor.

### P3 triage

After verification, a `standard` run that fixes makes one bulk read-only call
with the unchecked P3 findings below the floor. The call goes to the disprover
role's vendor at the medium tier and medium effort, and it splits only by token
size. It asks which findings are real and worth fixing given their stated cost.
Triage works as follows:

- A selected finding becomes `confirmed` with the call's evidence, goes to the
  fixer, and records `floorBypassReason`.
- The other findings stay `pending` and labeled. The engine doesn't ask about
  them again.
- `nit` findings and pull request comments aren't included. A `thorough` run and
  a read-only run skip triage.
- A refused call uses the fallback in [Retry a failed run](#retry-a-failed-run).
  Any other failure leaves the labels as they were, and the run goes on.
- A resumed stage reuses the saved call. A notice gives the number of findings read
  and sent to the fixer.

A finding at or above the floor that a disprover couldn't check stays pending
and holds the run open, as it does without a floor. Pull request comments and failing checks that the
post-push loop imports always go to a disprover, because the loop must answer
them. The floor doesn't change the rest of the post-push loop, so `pr_clean` can
carry the notice too.

## Stop conditions

A run ends, or stops for you, when one of the following holds:

| Condition | Result |
|---|---|
| Clean | Two rounds in a row, or one at the `standard` depth, confirm no finding above `nit`. The branch is ready to push. |
| Clean above the floor | The same test as clean, with findings below the verification floor left unchecked. The result is `clean_above_floor`, not `clean`. |
| Clean with follow-ups | The same test as clean, with findings that no vendor would check. The result is `clean_with_followups`. Check those findings yourself before you push. |
| Round cap | The run reaches its round limit: 2 by default at the `standard` depth, and 25 at `thorough`. The run stops and asks you. |
| Oscillation | A finding that a fix closed comes back. The run stops and asks you. |
| Ceiling or limit | A vendor is over its ceiling or reported a limit, and no other vendor can take the role. The run pauses until the reset, or asks you when no reset time is known. |
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

## Retry a failed run

A run with the `failed` status can resume from its saved state at the stage that
failed, including a run that failed before this control existed. To retry a run,
click **Retry** in the run view, or run the following command:

```bash
aio review retry RUN_ID --role disprover=codex --verify-floor P2

```

Replace `RUN_ID` with the run's ID. Both options are optional:

- `--role ROLE=VENDOR[,VENDOR]`: gives a role to vendors, as `aio review assign`
  does. You can repeat it. You can also use `aio review assign` or the role table
  in the run view while the run is failed, then retry.
- `--verify-floor SEVERITY`: sets the verification floor. Use `all` to remove the
  floor. Without the option, the run keeps its floor.

To stop relying on other vendors, click **Finish with Claude** in the run view, or
add `--finish-with-claude`. Claude takes the reviewer, disprover, and fixer roles,
and the cross-vendor rule stays off for the rest of the run, so Claude checks its
own findings. The run shows a notice that says so.

When a vendor's safety filter refuses a disprover call, the engine doesn't fail the
run or repeat the call. It tries Codex's small model, then Claude, and adds a notice
when Claude answers, because that check isn't independent. If they fail too, the
finding stays `pending` with `followUpReason`, the run goes on, and a run that would
stop clean stops with `clean_with_followups`. A retry checks those findings again.
A refused confirmer call moves the same way, and fails the run if nothing answers.

A retry works as follows:

- Saved calls answer from their files, so no finished call runs again and
  findings that already have verdicts keep them. A reproduction script for a
  saved answer runs again, because the engine owns that check.
- The roles return to the profile and your assignments, which drops any move a
  limit made. The engine forgets the vendor limits it remembers.
- A moved tip or a dirty tree doesn't stop a retry, as with any resume: the open
  round keeps checking the saved tip commit, the fix stage commits on the branch
  as it stands, and the next round reviews the new tip. The run shows a notice
  when the tip moved, and another with the error it retried after.

The engine refuses a retry, and changes nothing, in the following cases:

- The run's status isn't `failed`. A `cancelled` run stays final.
- The stage can't resume: `done`, or a stage of the other pipeline.
- The stored state is inconsistent: a missing base or tip commit, a closed round
  or missing round files at a stage that needs them, a missing merge file, a
  repeated finding, or a finding counter behind the findings.
- With the cross-vendor rule, no available vendor other than the reporter can
  check a pending finding at or above the floor.

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
