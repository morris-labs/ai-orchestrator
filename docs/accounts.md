# Accounts

An account is one sign-in to an agent CLI: Claude Code, Codex, or GitHub
Copilot. Each account has its own config folder, so you can keep several
accounts of one vendor, such as a personal Claude Max account and a work
Claude Pro account.

This page describes phases 1 and 2 of per-account agent config folders. You can create,
import, seed, and check accounts. Boxes use them when the `accountsMode`
setting is `accounts`; while it is `host`, the default, boxes still mount the
host's own folders. See [Run boxes on accounts](#run-boxes-on-accounts).

## How accounts work

The server keeps a record of each account in its database, and one folder per
account at `DATA_DIR/accounts/VENDOR/NAME`.

Replace the following:

- `DATA_DIR`: the server's data directory, `~/.ai-orchestrator` unless
  `--data-dir` or `AIO_DATA_DIR` sets another one
- `VENDOR`: `claude`, `codex`, or `copilot`
- `NAME`: the account's short name, such as `personal` or `work`

An account's ID is `VENDOR/NAME`, such as `claude/work`. A name holds
lowercase letters, digits, and hyphens, and is at most 32 characters long.

The folder holds everything that the CLI keeps in its home folder: settings,
history, and, after you sign in, the sign-in itself. Each CLI finds the folder
through one environment variable:

| Vendor | Variable | Host folder it replaces |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | `~/.claude` and `~/.claude.json` |
| Codex | `CODEX_HOME` | `~/.codex` |
| Copilot | `COPILOT_HOME` | `~/.copilot` |

Each vendor has a default account, stored in the global settings as
`accountDefaults`. The first account of a vendor becomes its default.

An account record also holds the following fields:

- `label`: a display name, such as "Work (Claude Pro)".
- `signIn`: whether the account is signed in, and the email or login that the
  CLI reports, as of the last check.
- `ceiling` and `overflow`: a usage ceiling for this account, and whether runs
  can move to it when another account is over its ceiling. Phase 1 stores
  these fields; the scheduler applies them from phase 3.

## Seed accounts from the host folders

Seeding creates the first account of each vendor from your host folders, so
that your settings, skills, history, and session lists carry over.

Before you seed, stop every box. Seeding refuses while any box runs, because
the CLIs in running boxes write to the folders that it copies.

To see what seeding would copy, run a dry run:

```sh
aio accounts seed --dry-run
```

To seed `claude/personal`, `codex/personal`, and `copilot/personal`, run the
command without the flag:

```sh
aio accounts seed
```

The command starts an `account_seed` job, waits for it, and prints what each
account received. To seed only some vendors, repeat `--vendor`, for example
`--vendor claude --vendor codex`. To use another name than `personal`, pass
`--name NAME`.

Seeding does the following for each vendor:

1. Refuses when the account record or its folder exists. Seeding never
   overwrites an account.
1. Copies the host folder into a temporary folder next to the account folder,
   and renames it into place when the copy is complete. A failed copy leaves no
   account folder behind.
1. Copies every file as opaque bytes, with its mode and times. Symbolic links
   stay links and aren't followed. A relative link that points outside the
   folder becomes absolute, so that it still points at the same place.
   Sockets and pipes are skipped. The copy leaves out `projects` and links the
   account's `projects` to the transcript store instead (see the
   **Transcripts** item later in this page).
1. Leaves out the sign-in files. The copy never opens them.
1. Records the account as not signed in, and makes it the vendor's default
   when the vendor has none.
1. Relabels the vendor's usage history: samples labeled with a legacy name,
   such as the Claude email or `codex-default`, get the account ID, so that
   usage and forecasts carry over.

Seeding also does the following for each vendor:

- **Claude Code**: copies `~/.claude.json` over the copy's own
  `.claude.json`, which is a stale file in `~/.claude`. The account gets a
  `projects` link to the transcript store, `DATA_DIR/transcripts/claude`. The
  copy never includes the host's transcripts. To bring them into the store,
  run `aio transcripts adopt` first.
- **Codex**: adds `cli_auth_credentials_store = "file"` to the top of the
  `config.toml` file when the file sets no store, because a container has no
  keyring.

### Files that seeding leaves out

Seeding uses a deny-list. It leaves out a file when its base name matches, at
any depth in the host folder:

- Sign-in files: `.credentials.json` (Claude Code), `auth.json` (Codex), and
  `config.json` (Copilot, which keeps its token there in plain text, next to
  its settings), plus the older candidates `hosts.yml`, `credentials.toml`,
  and `registered.tokens.json`
- Files that hold a token for other tools: `agent.env`, `.env`, and any
  file whose name ends in `.env`

In the copied Claude `.claude.json`, seeding also drops the `/login` API key
(`primaryApiKey`) and sets `installMethod` to `global`, so Claude Code in the
image doesn't warn that `~/.local/bin/claude` is missing. When `~/.claude.json`
is a link into `~/.claude/.claude.json`, seeding resolves the link and copies
the file.

Because the sign-in files stay behind, the host and each account don't share
a refresh token, and signing in or out on the host never affects a box. You
sign in once to each account. The host and the accounts share only the Claude
transcript store.

## Manage accounts

The following commands manage accounts. Each one calls the server's
`accounts.*` API routes.

- To list the accounts, run `aio accounts list`.
- To create an account with an empty folder, run
  `aio accounts add VENDOR NAME`. A Codex account gets a `config.toml`
  file that keeps its sign-in in a file.
- To make an account its vendor's default, run
  `aio accounts set VENDOR/NAME --default`. To change its label, pass
  `--label TEXT`; to let runs overflow to it, pass `--overflow on`.
- To ask the CLI whether an account is signed in, run
  `aio accounts check VENDOR/NAME`. The server runs the CLI's status
  command (`claude auth status` or `codex login status`) in a throwaway
  container from the engine image, with the account folder mounted, and
  stores the answer. Copilot has no status command outside an interactive
  session, so its state stays unknown.
  The command also warns when a Claude account's `projects` entry doesn't
  lead to the transcript store. The comparison follows links to their real
  paths, so a chain of links that ends at the store counts as the store.
- To repair the transcript links, run `aio accounts relink`. The command
  points every Claude account's `projects` entry at the store, and replaces a
  link that dangles or leads elsewhere. It removes only the link, never the
  folder it pointed to, and it keeps a real `projects` folder that holds
  transcripts.
- To install a folder that already holds a sign-in, run
  `aio accounts import VENDOR NAME --from DIR`. By default, the command
  moves the folder into `DATA_DIR/accounts/VENDOR/NAME`. Pass `--copy` to copy
  it instead; a Claude refresh token rotates each time it is used, so only
  one of the two copies may stay in use. The command never reads the sign-in
  files. Run `aio accounts check VENDOR/NAME` afterward to confirm that
  the account is signed in.
- To remove an account, run `aio accounts remove VENDOR/NAME`. The
  server deletes the record and keeps the folder, which can hold your only
  copy of its settings and history. Delete the folder yourself when you no
  longer need it. The server refuses to remove a vendor's default account.

Replace the following:

- `TEXT`: the account's display name
- `DIR`: the absolute path of the vendor's config folder, such as a
  `CLAUDE_CONFIG_DIR`

The server refuses an accounts folder under `/tmp`, `/var/tmp`, or `/dev/shm`,
because Codex won't run from a temporary directory.

## Share your Claude configuration

A new Claude account starts without your global `CLAUDE.md`, skills, or
settings. AI Orchestrator links these entries of the host's `~/.claude` into every
Claude account folder, so an edit on the host reaches every account:

- `CLAUDE.md`, `settings.json`, `keybindings.json`, `loop.md`
- `skills/`, `agents/`, `commands/`, `hooks/`, `output-styles/`, `rules/`,
  `plugins/`
- statusline scripts, such as `statusline.sh`

The server links only the entries that exist on the host. It never links
sign-in or per-account state: `.credentials.json`, `.claude.json`,
`policy-limits.json`, `remote-settings.json`, `sessions/`, `projects/` (which
links to the transcript store), `todos/`, `statsig/`, `history.jsonl`, and
`shell-snapshots/`. An entry that a later Claude Code version adds stays
per-account until the list in `accounts/userConfig.ts` names it.

The server links at account create, import, and seed, and in
`aio accounts relink`. To give the accounts that exist already their
links, run `aio accounts relink`.

To opt an account out of an entry, replace the link with a real file or
folder of the account's own. Relink and check leave it alone, and
`aio accounts check` reports it as a local override. A copy that is
identical to the host's is replaced by the link, because that loses nothing.
To use the host's entry again, move the account's copy away and run relink:

```sh
mv ~/.ai-orchestrator/accounts/claude/work/settings.json ~/settings.work.json
aio accounts relink
```

Containers see the links because the server mounts each linked host entry at
its own path, read-write, the way it mounts the transcript store. It does not
mount the whole `~/.claude`, because that folder holds the host's sign-in
(`.credentials.json`), and a refresh token that two sign-ins share can be
revoked. A container made before the links needs a restart to see them. A
mounted file such as `settings.json` is bound by its inode, so an editor that
replaces the file with a new one on save (rather than writing in place)
leaves running containers on the old content until they restart.

### Settings that you share

When `settings.json` is a link to the host's file, the server never writes to
it, because that would change your host file:

- **Retention**: the protected `cleanupPeriodDays` comes from the host's file
  itself. If the file lacks a value that is at least the
  `transcriptRetentionDays` setting (3650 by default), the start fails with a
  message that names the file. Add the key there, or replace the link with a
  file of the account's own.
- **Bypass warning**: the server doesn't write
  `skipDangerousModePermissionPrompt`. Claude Code reads it only from user
  settings, so there is no account-local place for it. If the host's file
  lacks it, `aio accounts check` warns, and a box that enters bypass
  permissions mode shows Claude's warning once. Add the key to the host's file
  to silence it. Boxes start in auto mode, which doesn't show the warning.

## Run boxes on accounts

To switch boxes from the host's folders to accounts, do the following:

1. Make sure each vendor you use has an account and a default. Seed, import,
   or add one, then run `aio accounts check VENDOR/NAME`.
1. Run `aio accounts check VENDOR/NAME` for each Claude account and fix
   any warning about the transcript store with `aio accounts relink`.
   The server refuses the switch when the host's `~/.claude/projects` leads
   to a folder other than the store and holds conversations (run
   `aio transcripts adopt`), and when a Claude account's `projects`
   doesn't lead to the store.
1. Run `aio accounts mode accounts`.
1. Restart each project container. A container made before the switch is
   stale ("accounts mode host -> accounts") and the server restarts it only
   when it has no sessions or you ask.

To go back, run `aio accounts mode host` and restart the containers.

In accounts mode, a box behaves as follows:

- **Account choice**: each box uses one account per vendor. The main session
  uses the account of the box's platform; side sessions use the account of
  their own vendor. A vendor without a choice uses its default account.
  To choose, pass `--account VENDOR/NAME` to `aio box new` (repeat it
  for several vendors), use the Account field in the New Box, Edit Box, and
  Fork Conversation dialogs, or run `aio box account BOX ACCOUNT`. A
  fork keeps the source box's accounts unless you choose others.
- **Session command**: the server starts each session as
  `env CLAUDE_CONFIG_DIR=ACCOUNT_DIR claude ...` (or `CODEX_HOME`,
  `COPILOT_HOME`), so one container hosts sessions of several accounts.
- **Mounts**: the container mounts `DATA_DIR/accounts` at its host path and
  nothing from `~/.claude`, `~/.codex`, or `~/.copilot` except the entries
  that Claude accounts link to (see "Share your Claude configuration"). Each Claude account's
  `sessions` folder is the container's own directory, and the target of any
  link at the top of a Claude account folder (such as `projects`) is mounted
  at its own path. In the container, `~/.claude`, `~/.claude.json`, `~/.codex`,
  and `~/.copilot` link to each vendor's default account, for a bare command
  that you type in a container shell. The server leaves a path there that
  is a real file or folder alone and logs a warning that names it. When the
  account's shared entries (see "Share your Claude configuration") are
  mounted at their host paths under `~/.claude`, Docker creates
  `~/.claude` as a folder to hold them, so it can't be a link; the warning
  names those mounts as the cause. Boxes and review runs aren't affected,
  because they name the account folder themselves.
- **Transcripts**: every Claude account's `projects` link leads to one shared
  store, `DATA_DIR/transcripts/claude` (`~/.ai-orchestrator/transcripts/claude`
  by default), so a conversation resumes under any Claude account. The store
  doesn't follow the host's `~/.claude/projects`: the optional
  `transcriptStore` setting is the only override. Import, seed, and add
  replace a `projects` link that dangles or leads elsewhere with a link to
  the store. The `/resume`
  picker lists conversations that other accounts started, and accounts share
  each folder's auto memory.
- **First start**: before a box starts on a Claude account, the server sets
  `projects[FOLDER].hasTrustDialogAccepted` in the account's `.claude.json`
  for the box's folders, sets `installMethod` to `global` when it is missing,
  and sets `skipDangerousModePermissionPrompt` in the account's
  `settings.json` (the setting that Claude Code 2.1.316 reads for the bypass
  permissions warning). The box then doesn't wait at the folder trust prompt
  or the bypass warning. The server changes only those keys, and leaves a file
  that isn't a JSON object alone.
- **New account**: a container that started before you added a Claude account
  has no `sessions` mount for it. Starting a box on that account fails with
  `stale_mounts` until you restart the container.
- **Change of account**: a change applies when the box restarts. A box that runs Claude
  resumes its conversation. A Codex or Copilot box starts a new session,
  because the old one stays in the old account's folder.
- **Models**: the model list and the defaults come from the chosen Claude
  account's `.claude.json` and `settings.json`.

Review runs use the default account of each vendor. The server writes the
default account folders to `account-dirs.json` in a folder that the container
mounts read-only at `/run/aio-config` when the container starts, and rewrites
it for each running container when you change a default or the accounts mode.
For every model call, the engine reads the file and starts the CLI with
`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `COPILOT_HOME` set to the folder, so a
new default applies from the next call without a container restart. A session
that continues stays in the account folder it started in. The server also moves
the container's home links to the new default.

A restart is still needed in two cases, and the server logs the second:

- A container launched in host mode stays on its home folders after you switch
  to accounts mode.
- A running container keeps its previous Claude account when the default moves
  to an account made after the container started.

The engine doesn't depend on the `~/.claude` link in the container's home. In
host mode, the file holds no folders and each CLI uses its home folder.

## Transcript retention

> **Warning:** Claude Code deletes transcripts older than `cleanupPeriodDays`
> (30 by default) from its `projects` folder. Every Claude account's
> `projects` link leads to the shared store, so one account whose
> `settings.json` lacks the key deletes old conversations for every account
> and for the host. This happened once: the host's `settings.json` set 3650,
> imported accounts didn't, and the first box starts in accounts mode removed
> every transcript older than 30 days.

AI Orchestrator makes this impossible in the following ways:

- **Before every Claude session start** on an account, the server makes sure
  that the account's `settings.json` sets `cleanupPeriodDays` to at least the
  protected value. It never lowers a larger value. When it can't make sure,
  because the file isn't a JSON object or isn't writable, the start fails with
  `invalid_state` and a message that names the file.
- **At account create, import, and seed**, the server sets the same key.
- **The protected value** is `cleanupPeriodDays` from the host's
  `~/.claude/settings.json` when it sets one. Otherwise it is the
  `transcriptRetentionDays` setting, which defaults to 3650 days.
- **`aio accounts check`** warns about an account whose `settings.json`
  lacks the key or sets a lower value. It also warns when
  `desktopSessionCleanupPeriodDays` is above 0.

Claude Code 2.1.316 has one other key with "cleanup" in its name,
`desktopSessionCleanupPeriodDays`. It sets a deletion ceiling for transcripts
of the desktop app and Cowork only, and its default of 0 means no ceiling.
AI Orchestrator doesn't write it. Claude Code ignores both keys when an
organization's managed settings set `cleanupPeriodDays`, and project-level
`.claude/settings.json` files can also set the key; check those if
transcripts disappear.

### Transcript snapshots

Before the first Claude start in accounts mode after the server starts, the
server takes a snapshot of the transcript store: a copy of the folder tree in
which every file is a hard link to the store's file, like `cp -al`. It lives
in `DATA_DIR/backup/transcripts/TIMESTAMP`, costs one directory entry per file
and no file content, and the server keeps the newest 7.

A snapshot protects against a file that another process deletes or replaces,
such as Claude Code's cleanup. It doesn't protect against an edit in place:
a transcript that a conversation appends to is the same file in the snapshot.
It can't cross file systems, so a `transcriptStore` setting on another
file system logs a failure and takes no snapshot. A failed snapshot never
blocks a start.

To change the number of snapshots, send `PATCH /api/v1/settings` with
`{"transcriptBackupKeep": 14}`; `0` turns snapshots off and `null` restores
7. The same call sets the protected retention with `transcriptRetentionDays`.

## Remove a project

To delete a project's record, run `aio project remove PROJECT_ID`, or
send `DELETE /api/v1/projects/PROJECT_ID`. The server refuses a project that
has boxes. With `--force` (`?force=true`), it removes the box records first,
and refuses while any of those boxes runs. It never deletes the project's
folder, a worktree, or a transcript.

## Back up accounts

The account folders hold settings, history, and sign-ins that exist nowhere
else once you use them. Include `DATA_DIR/accounts` in your backups, and
don't delete it when you reinstall AI Orchestrator.

## Move the host's transcripts into the store

`~/.ai-orchestrator` is the only folder in your home directory that AI Orchestrator uses
for its own data, so the transcript store lives there. In host mode, the
containers mount the host's `~/.claude`, and its `projects` entry must lead to
the store. A chain of links works, for example
`~/.claude/projects` to another link to `~/.ai-orchestrator/transcripts/claude`.
The server follows the whole chain to its real path and mounts each link
path outside `~/.claude`, and the final folder, at the same path in the
container. A link inside `~/.claude` needs no extra mount.

To move an existing `~/.claude/projects` folder, or the folder its link leads
to, into the store, do the following:

1. Stop every box. The command refuses to run while a box runs.
1. Run `aio transcripts adopt --dry-run` and read the plan.
1. Run `aio transcripts adopt`.

The command does the following:

- Moves the files into `DATA_DIR/transcripts/claude`. It never overwrites a
  file. A file that exists in both places with the same content counts as a
  duplicate. If any file exists in both places with different content, the
  command reports the clashes, exits with code 1, and changes nothing. Resolve
  the clashes by hand and run the command again.
- Points `~/.claude/projects` at the store. It replaces a real folder only
  after the move leaves it empty.
- Removes an intermediate link in the old chain only when that link points at
  the store. Other links and the emptied old folder stay; remove them by hand.

If `~/.claude/projects` already leads to the store through other links, the
command only repoints it at the store directly.
