# Policy file

A policy file tells the review pipeline what matters in one repository:
which paths are risky, which extra rules reviewers apply, how to run the
tests and lint, and what the reviewers must know about where the code runs.
The pipeline itself stays the same for every repository.

## Location

The policy file lives at `PROJECT/.aio/policy.yaml`, where `PROJECT`
is the project root. Git ignores the `.aio/` directory, so the policy
stays local to your machine. To keep it somewhere else, set the project's
policy path in the project settings; a relative path is relative to the
project root.

To edit the policy, open the project in **AI Orchestrator Review** and click
**Policy**. The editor validates the file before it saves it. You can also
edit the file in any text editor; the engine reads it at the start of each
run.

A repository without a policy file gets the defaults: no risk paths, no
extra rules, no test or lint commands, and a group size limit from the run's
[depth](review-pipeline.md#depth): 1500 changed lines at `standard`, and 400 at
`thorough`.

## Example

The following file is a policy for a web service with a payments module:

```yaml
version: 1

# Files that always count as major, so they get the deepest review.
riskPaths:
  - "src/payments/**"
  - "src/auth/**"
  - "migrations/**"

# Rules that every reviewer and disprover reads in its prompt.
rules:
  - id: no-card-data-in-logs
    text: >-
      Never log card numbers, CVV codes, or full billing addresses. Flag any
      logger call that receives a payment request object.
    appliesTo:
      - "src/payments/**"
  - id: parameterized-sql
    text: Build every SQL statement with bound parameters, never by string concatenation.

# Commands the gate runs before the first round and after every fix.
tests:
  - command: npm test
lint:
  - command: npm run lint
  - command: npx tsc --noEmit
    cwd: packages/api

# Facts the reviewers can't see from the code.
environmentLimits:
  - The service runs on Linux only; ignore Windows path handling.
  - Production has no outbound internet access.

# A file group with more changed lines than this splits into smaller groups.
groupSizeLimit: 300
```

## Fields

The policy file has the following fields. Field names are case-sensitive,
and the engine rejects a file with an unknown field, so a misspelled field
fails the run's preflight instead of being ignored. The engine also rejects
a malformed glob, such as `src/{auth,api` without its closing brace, and
names the field that holds it.

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | Integer | Required | The file format version. Must be `1`. |
| `riskPaths` | List of globs | `[]` | Paths whose file groups always count as major. |
| `rules` | List of rules | `[]` | Extra review rules. Each rule has an `id`, a `text`, and an optional `appliesTo` list of globs. A rule without `appliesTo` applies to every file. |
| `tests` | List of commands | `[]` | Test commands for the gate. Each has a `command` and an optional `cwd` relative to the repository root. |
| `lint` | List of commands | `[]` | Lint commands for the gate, in the same form as `tests`. |
| `environmentLimits` | List of strings | `[]` | Facts about where the code runs, added to every reviewer and disprover prompt. |
| `groupSizeLimit` | Positive integer | Set by the run's depth | The changed-line count above which a file group splits. A value in the file wins at every depth. The **Policy** editor writes this field when it saves, so a file it saved names a limit. |
| `commentAuthors` | List of strings | Absent | GitHub logins whose pull request comments the post-push loop imports. The loop always imports Copilot's comments. When you set this field, the loop imports comments from these logins instead of from the repository's collaborators. Logins are case-insensitive. |
| `tierModels` | Map | Absent | Models per vendor and tier, such as `claude: { small: claude-haiku-5-5 }`, over the built-in mappings. The engine refuses a model that [review runs must not use](review-pipeline.md#blocked-models). |
| `tierPaths` | List of rules | Absent | Model tiers for paths. Each rule has a `paths` list of globs and a `tier` of `small`, `medium`, or `large`. The first rule that matches a file wins. A `small` rule gives a file that holds code the `medium` tier. |

## How the pipeline uses the policy

- **Group stage**: a file that matches a `riskPaths` glob makes its group
  major, whatever its size, and `groupSizeLimit` decides when a group
  splits.
- **Find and verify stages**: each reviewer and disprover prompt includes
  the `rules` that apply to the files under review and every
  `environmentLimits` entry.
- **Preflight and gate stages**: the engine runs `tests` and `lint` inside
  the container before the first round to record a baseline, and again
  after each fix. A command that passed at the baseline and fails after a
  fix sends the round back to the fix stage. A command that already failed
  at the baseline doesn't block the run. The commands run in your checkout, and
  the engine never deletes files there: untracked files that appear while
  they run stay, and the engine log lists them.

When a repository has no `tests` or `lint` commands, the gate has nothing to
run and passes.
