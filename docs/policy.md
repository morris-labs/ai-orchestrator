# Policy file

A policy file tells the review pipeline what matters in one repository:
which paths are risky, which extra rules reviewers apply, how to run the
tests and lint, and what the reviewers must know about where the code runs.
The pipeline itself stays the same for every repository.

## Location

The policy file lives at `PROJECT/.claude-box/policy.yaml`, where `PROJECT`
is the project root. Git ignores the `.claude-box/` directory, so the policy
stays local to your machine. To keep it somewhere else, set the project's
policy path in the project settings; a relative path is relative to the
project root.

To edit the policy, open the project in **Agent Box Review** and click
**Policy**. The editor validates the file before it saves it. You can also
edit the file in any text editor; the engine reads it at the start of each
run.

A repository without a policy file gets the defaults: no risk paths, no
extra rules, no test or lint commands, and a group size limit of 400 changed
lines.

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
fails the run's preflight instead of being ignored.

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | Integer | Required | The file format version. Must be `1`. |
| `riskPaths` | List of globs | `[]` | Paths whose file groups always count as major. |
| `rules` | List of rules | `[]` | Extra review rules. Each rule has an `id`, a `text`, and an optional `appliesTo` list of globs. A rule without `appliesTo` applies to every file. |
| `tests` | List of commands | `[]` | Test commands for the gate. Each has a `command` and an optional `cwd` relative to the repository root. |
| `lint` | List of commands | `[]` | Lint commands for the gate, in the same form as `tests`. |
| `environmentLimits` | List of strings | `[]` | Facts about where the code runs, added to every reviewer and disprover prompt. |
| `groupSizeLimit` | Positive integer | `400` | The changed-line count above which a file group splits. |

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
  at the baseline doesn't block the run.

When a repository has no `tests` or `lint` commands, the gate has nothing to
run and passes.
