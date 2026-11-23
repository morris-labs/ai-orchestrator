# Accounts

An **Account** is a vendor sign-in and its configuration folder. Each account
owns its settings, instructions, skills, plugins, and history under
`DATA_DIR/accounts/VENDOR/NAME`. `DATA_DIR` defaults to `~/.ai-orchestrator`;
`VENDOR` is `claude`, `codex`, or `copilot`. An account ID such as
`claude/work` names both the vendor and account. Names contain lowercase
letters, digits, and hyphens and are at most 32 characters long.

Boxes and host sessions use the same account folder. They don't use the host
user's personal vendor folders as runtime configuration. An explicit seed can
copy selected host files once; relink converts old links without changing
their targets. The shared Claude transcript store is the exception to account
folder isolation.

## Set up accounts

Create an account, sign in to it, and select accounts mode:

```sh
aio accounts add claude personal
aio claude --account personal -- auth login
aio accounts check claude/personal
aio accounts mode accounts
```

The first account of each vendor becomes its default. Use
`aio accounts set VENDOR/NAME --default` to change that choice. The server
refuses account folders that resolve to the host's own vendor folder, or live
under a temporary directory such as `/tmp`.

An installation still configured with `accountsMode: host` can load its saved
settings, but box creation and starts fail with instructions to set up
accounts. It never falls back to host vendor folders. Switching is a manual
choice; the upgrade doesn't convert the installation automatically.

### Convert existing accounts

Stop work before converting old links:

```sh
aio accounts relink
aio accounts mode accounts
```

Relink replaces file and directory links into host vendor folders with copies
of their targets. Real files and directories stay unchanged; repeating relink
leaves converted entries unchanged. The host folders stay unchanged. Relink
also creates missing instruction files and repairs each Claude account's
`projects` link to the shared transcript store. It keeps a real `projects`
folder that contains transcripts instead of removing it.

Restart existing project containers after conversion to remove their old
mounts. Future edits and atomic file replacements in account folders reach
running containers through the accounts directory mount. Adding skills or
plugins doesn't require new single-file mounts. A CLI may still need a new
session to load a setting.

The server installs the skills it ships, such as `aio-build`, into each
Claude account at every start, and into an account created after the start at its first box start.
It writes only the `skills/NAME/` folder of each packaged skill and replaces
files there that differ from the package, so keep your own changes in
another skill. A `skills` folder that is a link to somewhere else is left
alone, and the server logs why. For the build skill, see
[Run your first build](build-pipeline/first-build.md).

## Run vendor CLIs on the host

```sh
aio claude --account personal -- --model sonnet
aio codex --account work -- --model MODEL
aio copilot --account work -- --help
```

`--account NAME` defaults to that vendor's default account. Everything after
`--` passes unchanged to the vendor CLI. These commands require a running
server and the vendor CLI installed on the host. They return the vendor CLI's
exit code and report unknown accounts or connection failures directly.

| Command | Child environment variable |
|---|---|
| `aio claude` | `CLAUDE_CONFIG_DIR` |
| `aio codex` | `CODEX_HOME` |
| `aio copilot` | `COPILOT_HOME` |

The child receives its account folder and doesn't inherit `AIO_TOKEN` or
`AIO_SERVER_TOKEN`. Codex and Copilot instructions are rebuilt before the CLI
starts. Include problems appear on standard error and don't prevent launch.

For example, define a shell alias to use one account by default:

```sh
alias claude='aio claude --account personal --'
```

## Instruction layers

**Global instructions** live in `DATA_DIR/accounts/AGENTS.md`. **Account
instructions** belong to the individual account. New editable instruction
files contain a one-line comment so you can add your own rules. Creation and
relink create missing files without overwriting files you have edited.

Global instructions come first, followed by Account instructions. Write the
account's wording to express stricter rules or override global guidance. For
example, a work account can forbid GitHub access even when global instructions
describe a general GitHub workflow. Instructions guide the agent; they don't
create an access-control boundary.

An **Include line** is a line such as `@../shared/rules.md`. Its path resolves
relative to the file that includes it. Use include lines to share text between
selected accounts without symbolic links.

### Claude Code

Each Claude account has editable `AGENTS.md` and a `CLAUDE.md` with these
include lines, in this order:

```text
@../../AGENTS.md
@AGENTS.md
```

Claude Code follows these imports itself. You can edit the files and add more
include lines. Relink doesn't replace your existing `CLAUDE.md`.

### Codex and Copilot

Edit the account's `instructions.md`. Its initial include line loads Global
instructions before the account's own text:

```text
@../../AGENTS.md
# Add account instructions below.
```

At each box or session start, and before `aio codex` or `aio copilot`, the
server expands includes into the vendor's output file:

| Vendor | Generated file |
|---|---|
| Codex | `AGENTS.md` |
| Copilot | `copilot-instructions.md` |

The output contains Global instructions, Account instructions, then a generated
stamp and the source files to edit. Edit the sources; the output is rebuilt on
the next start. Missing includes are reported and skipped. Expansion stops at
three levels, so loops and deeper includes can't hang a start. Edits don't
reload into an already-running Codex or Copilot session.

## Seed from a host setup

Seeding is an explicit one-time copy, not synchronization. Stop boxes first;
seeding refuses while boxes run. Preview the copy with:

```sh
aio accounts seed --dry-run
```

By default, `aio accounts seed` creates `personal` accounts from the host's
sign-in files. Claude also receives the host's `.claude.json`; Codex receives
file-based credential storage configuration. No arbitrary host settings,
history, skills, or plugins are copied by default. The new accounts receive
their own instruction files and required retention settings.

To copy the host's Claude setup as well, opt in:

```sh
aio accounts seed --vendor claude --copy-host-setup
```

The option copies `CLAUDE.md`, `settings.json`, `skills`, and `plugins` once.
Missing entries are skipped. Links in copied content are resolved into real
files and directories, so the account doesn't depend on the host afterward.
The seed control in the apps offers the same option, off by default.

The command runs an `account_seed` job and reports what it copied. Repeat
`--vendor VENDOR` to select vendors, or pass `--name NAME` instead of
`personal`. Existing account records or folders are never overwritten. A
failed copy leaves no partial account folder.

A provider can rotate a refresh token. Using copied credentials in both the
host's personal setup and an account can sign out one copy. Prefer signing in
separately to each account when both will stay in use.

## Manage accounts and boxes

- `aio accounts list` lists accounts.
- `aio accounts set VENDOR/NAME --label TEXT` changes the display label;
  `--overflow on` permits scheduling work on that account.
- `aio accounts check VENDOR/NAME` runs the vendor's sign-in check and reports
  account-local retention, permissions, or transcript-store problems. It no
  longer warns that settings or instruction files aren't linked to the host.
- `aio accounts import VENDOR NAME --from DIR` moves an existing account
  folder into place; `--copy` leaves the source in place. Run a sign-in check
  afterward.
- `aio accounts remove VENDOR/NAME` removes the record and keeps the folder.
  The vendor's default account must be changed before it can be removed.

Each box chooses one account per vendor. Pass `--account VENDOR/NAME` to
`aio box new`, use the account controls in the apps, or run
`aio box account BOX ACCOUNT`. A vendor with no explicit choice uses its
default. Review runs use vendor defaults. A changed choice applies to the
next session; existing sessions keep the account they started with.

The box model catalog reads account defaults from the selected vendor's
configuration. Claude uses the `settings.json` file and adds model suggestions
from the `.claude.json` file. Codex reads `model` and `model_reasoning_effort`
from the account's `config.toml` file. Copilot reads the account's `config.json`
file. All three catalogs include suggestions from the engine image when a scan
finds model IDs.

Containers mount the accounts directory and the transcript store. They don't
mount the host's `.claude`, `.claude.json`, `.codex`, or `.copilot`. Container
home links point to default account folders for bare vendor commands typed
inside a container. All processes in a project container run as the same user
and can access its mounted accounts; separate account choices aren't a sandbox
between processes.

## Transcripts and retention

Claude accounts share `DATA_DIR/transcripts/claude` through their `projects`
links. A conversation can resume under another Claude account. Configure a
different store through `transcriptStore` if needed. Back up both
`DATA_DIR/accounts` and the transcript store.

Before every Claude start, and on create, import, or seed, the server ensures
that the account's `settings.json` sets `cleanupPeriodDays` to at least
`transcriptRetentionDays` (3650 by default). It keeps a larger account value.
An unreadable, invalid, or unwritable file blocks the start with a named
error. The protection comes from server settings, not host vendor settings.
Account checks also warn about positive `desktopSessionCleanupPeriodDays`.

Before the first Claude session after server startup, the server snapshots the
store with hard links under `DATA_DIR/backup/transcripts`. It keeps seven
snapshots by default. Set `transcriptBackupKeep` to change this, or to `0` to
turn it off. Snapshots protect against deleted or replaced files, but not
in-place edits. A snapshot failure is logged and doesn't block a start.

For a legacy transcript migration, `aio transcripts adopt --dry-run` shows the
explicit move plan, and `aio transcripts adopt` performs it. This separate,
opt-in migration can change the host's `projects` link; normal account
creation, relink, and starts don't adopt or modify the host transcript folder.
