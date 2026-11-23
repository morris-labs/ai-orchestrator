# Role definition format

A role definition is a Markdown file that describes one job on a build team.
The engine starts each agent from a role definition, so you change what an
agent does by editing a file, not the engine. For the roles in a build and
how the engine seats them, see the [build pipeline design](design.md).

## Where roles live

The engine reads roles from two places, in this order:

1. The role library, which ships with the engine. It holds the Developer
   role.
2. The repository's `.aio/team/` directory.

A repository role replaces the library role of the same name, so you can
change the Developer's rules for one repository without changing the engine.
A repository role with a name that the library doesn't use adds a role.

The engine reads only the Markdown files directly in the `.aio/team/`
directory. Subdirectories, such as `.aio/team/specialties/`, hold other
files. For more information about specialties, see
[Specialties](specialties.md).

Each file name must match the role's `name` field: the `developer` role lives
in the `developer.md` file. The engine refuses an invalid repository role. It
doesn't fall back to the library role of the same name.

## File layout

A role file starts with YAML front matter between two `---` lines. The
Markdown after the front matter holds the role's standing instructions, which
open every prompt for the role.

The following example defines a read-only role:

```markdown
---
name: notes-reviewer
title: Notes reviewer
purpose: Reads the project notes and reports gaps.
activation:
  group: bench
  when: The project keeps notes in the docs directory.
inputs:
  - name: notes
    description: The notes to read.
outputs:
  - name: report
    description: The gaps that the reviewer found.
    schema:
      type: object
      required: [gaps]
      properties:
        gaps: { type: array, items: { type: string } }
permission:
  access: read-only
placement:
  vendor: codex
  tier: medium
  effort: low
turnTimeoutMinutes: 20
rules:
  - Report only gaps that you can point to in a file.
---

Read the notes, then compare them with the code.
```

## Fields

Every field in the following table is required, and the engine refuses a
file with a field that the table doesn't list. The error message names the
file and each missing or unknown field, such as `placement.speed: unknown
field`.

| Field | Type | Description |
|---|---|---|
| `name` | String | The role's ID: lowercase letters, digits, and inner hyphens, at most 64 characters. It must match the file name. |
| `title` | String | The name that people read, such as `Test engineer`. The prompt opens with it. |
| `purpose` | String | What the role does, in one or two sentences. |
| `activation` | Object | When the engine seats the role. See [Activation](#activation). |
| `inputs` | List | What the role's agent receives. Each item has a `name` and a `description`. The list can be empty. |
| `outputs` | List | What the role's agent produces, at least one item. Each item has a `name`, a `description`, and an optional `schema`. See [Outputs](#outputs). |
| `permission` | Object | What the role's agent can change. See [Permission](#permission). |
| `placement` | Object | The default vendor, model tier, and effort. See [Placement](#placement). |
| `turnTimeoutMinutes` | Integer | How long one turn of the role's agent can run, from 1 to 1,440 minutes. |
| `rules` | List of strings | Rules that the prompt lists under **Rules**. The list can be empty. |

### Activation

The `activation` object has the following fields:

- `group`: `core` for a role that every build seats, `bench` for a role that
  the engine seats from the project's traits, or `on-call` for a role that a
  trigger activates.
- `when`: optional. The trait or trigger that seats the role, in words. Core
  roles leave it out.
- `form`: optional. `seat` for a role that puts an agent to work, or `lens`
  for a role that adds a focus area to the review pipeline. Default: `seat`.

### Outputs

An output with a `schema` field is part of the agent's JSON answer. The
`schema` field holds a JSON schema. When one output has a schema, the agent
answers with an object that matches it. When several outputs have one, the
agent answers with an object that holds each output under its name.

An output without a schema, such as the Developer's commits, describes work
that the agent leaves in the repository.

### Permission

The `permission` object takes one of the following forms:

- `access: read-only`: the agent changes no file.
- `access: write` with `paths`: the agent changes only the files that match
  the repository-relative globs in `paths`, at least one. The `{owned}` glob
  stands for the task's owned files.

The following example lets an agent change its task's owned files and the
changelog:

```yaml
permission:
  access: write
  paths: ["{owned}", "CHANGELOG.md"]
```

### Placement

The `placement` object is the role library default, the first placement
level. A single-vendor setting, the build plan, and a live change override it.
It has the following fields:

- `vendor`: `claude`, `codex`, or `copilot`.
- `tier`: `small`, `medium`, or `large`. The repository policy maps each tier
  to a model.
- `effort`: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

## The prompt for a task

The engine builds an agent's prompt from the role and one task, in the
following order:

1. The title and purpose: `You are the TITLE on a build team. PURPOSE`.
2. The role's standing instructions.
3. The rules: the permission rule, then the role's `rules` list.
4. The task: its ID, title, description, repository, and branch.
5. The task's owned files, contracts, acceptance criteria, tests that must
   pass, and context. The prompt leaves out an empty section.
6. The outputs, then the JSON schema of the answer when an output has one.
