# Specialties

A specialty is a named pack of guidance for one technology, such as Node.js,
TypeScript, or Go. A role sets an agent's job and its rules; a specialty adds
knowledge of the technology that a task uses. For how specialties fit into a
build, see the [build pipeline design](design.md).

Each task in a build plan lists its specialties by name. The engine adds the
text of each one to the prompt of every agent that works on the task, such as
the Developer and the Test engineer, on any vendor. A Claude agent and a Codex
agent on one task get the same text.

## Where specialties live

The engine looks up a specialty by name in the following places, in this
order, and uses the first one it finds:

1. The `.aio/team/specialties/NAME.md` file in the repository.
1. The `.aio/team/specialties/NAME/SKILL.md` file in the repository.
1. The `skills/NAME/SKILL.md` file in an account folder: the Claude account
   first, then the Codex and Copilot accounts.

Replace `NAME` with the specialty's name.

A repository specialty overrides an account skill of the same name, so a
repository can change the guidance that its builds get without changing the
account.

A name uses lowercase letters, digits, and inner hyphens, at most 64
characters, such as `typescript-dev`. The name matches the file name or the
skill folder name.

## Add a specialty to a repository

To give a repository's builds guidance for a technology, follow these steps:

1. In the repository, create the `.aio/team/specialties/` directory.
1. In that directory, create a Markdown file named after the specialty. For
   example, the `csv-export.md` file defines the `csv-export` specialty:

   ```markdown
   ---
   name: csv-export
   description: Rules for the CSV files that the app writes.
   ---

   - Write UTF-8 with a header row.
   - Quote every field that holds a comma, a quotation mark, or a line break.
   - Name every export function `exportNOUN`, such as `exportOrders`.
   ```

   The front matter is optional, and the engine leaves it out of the prompt.
   The rest of the file is the guidance. A file with no guidance is invalid.

1. Commit the file, so that the build's worktrees include it.

When a specialty needs supporting files, use a folder instead: put the
guidance in the `.aio/team/specialties/NAME/SKILL.md` file and the supporting
files next to it.

## Use an account skill as a specialty

A skill in an account's `skills` folder is a specialty with the skill's name.
For example, the `typescript-dev` skill in the
`~/.ai-orchestrator/accounts/claude/ACCOUNT/skills/typescript-dev/` folder is
the `typescript-dev` specialty. Replace `ACCOUNT` with the account's name.

The engine reads the skill's `SKILL.md` file without its front matter. It
also lets the agent read the skill's folder, so that guidance that refers to
other files in the folder still works on every vendor.

## Tag a task with specialties

The Architect tags each task in the build plan with its specialties. A task
can have several, and each name can appear once.

Plan validation checks every name. A plan whose task names an unknown
specialty fails, and the message names the task and the specialty, such as
`task T2 names cobol-dev`. To fix it, add the specialty to the repository or
the account, or remove the name from the task.

## Usage by specialty

Each agent call of a task names the task's specialties, so usage breaks down
by specialty as well as by seat and by step. The `bySpecialty` field of a
build's usage holds one row per specialty, sorted by name, and a last row for
calls whose task names none.

A call with several specialties counts in the row of each one, so the rows
can add up to more than the build's total.

To read a build's usage, send a `GET` request to the
`/api/v1/builds/BUILD_ID/usage` path of the server. Replace `BUILD_ID` with
the ID of the build.
