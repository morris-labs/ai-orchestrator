# Accounts

An account is one sign-in to an agent CLI: Claude Code, Codex, or GitHub
Copilot. Each account has its own config folder, so you can keep several
accounts of one vendor, such as a personal Claude Max account and a work
Claude Pro account.

This page describes phases 1 and 2 of the design in
[Per-account agent config folders](v4/design-accounts.md). You can create,
import, seed, and check accounts. Boxes use them when the `accountsMode`
setting is `accounts`; while it is `host`, the default, boxes still mount the
host's own folders. See [Run boxes on accounts](#run-boxes-on-accounts).

## How accounts work

The server keeps a record of each account in its database, and one folder per
account at `DATA_DIR/accounts/VENDOR/NAME`.

Replace the following:

- `DATA_DIR`: the server's data directory, `~/.claude-box` unless
  `--data-dir` or `AGENTBOX_DATA_DIR` sets another one
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
agentbox accounts seed --dry-run
```

To seed `claude/personal`, `codex/personal`, and `copilot/personal`, run the
command without the flag:

```sh
agentbox accounts seed
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
  run `agentbox transcripts adopt` first.
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

- To list the accounts, run `agentbox accounts list`.
- To create an account with an empty folder, run
  `agentbox accounts add VENDOR NAME`. A Codex account gets a `config.toml`
  file that keeps its sign-in in a file.
- To make an account its vendor's default, run
  `agentbox accounts set VENDOR/NAME --default`. To change its label, pass
  `--label TEXT`; to let runs overflow to it, pass `--overflow on`.
- To ask the CLI whether an account is signed in, run
  `agentbox accounts check VENDOR/NAME`. The server runs the CLI's status
  command (`claude auth status` or `codex login status`) in a throwaway
  container from the engine image, with the account folder mounted, and
  stores the answer. Copilot has no status command outside an interactive
  session, so its state stays unknown.
  The command also warns when a Claude account's `projects` entry doesn't
  lead to the transcript store. The comparison follows links to their real
  paths, so a chain of links that ends at the store counts as the store.
- To repair the transcript links, run `agentbox accounts relink`. The command
  points every Claude account's `projects` entry at the store, and replaces a
  link that dangles or leads elsewhere. It removes only the link, never the
  folder it pointed to, and it keeps a real `projects` folder that holds
  transcripts.
- To install a folder that already holds a sign-in, run
  `agentbox accounts import VENDOR NAME --from DIR`. By default, the command
  moves the folder into `DATA_DIR/accounts/VENDOR/NAME`. Pass `--copy` to copy
  it instead; a Claude refresh token rotates each time it is used, so only
  one of the two copies may stay in use. The command never reads the sign-in
  files. Run `agentbox accounts check VENDOR/NAME` afterward to confirm that
  the account is signed in.
- To remove an account, run `agentbox accounts remove VENDOR/NAME`. The
  server deletes the record and keeps the folder, which can hold your only
  copy of its settings and history. Delete the folder yourself when you no
  longer need it. The server refuses to remove a vendor's default account.

Replace the following:

- `TEXT`: the account's display name
- `DIR`: the absolute path of the vendor's config folder, such as a
  `CLAUDE_CONFIG_DIR`

The server refuses an accounts folder under `/tmp`, `/var/tmp`, or `/dev/shm`,
because Codex won't run from a temporary directory.

## Run boxes on accounts

To switch boxes from the host's folders to accounts, do the following:

1. Make sure each vendor you use has an account and a default. Seed, import,
   or add one, then run `agentbox accounts check VENDOR/NAME`.
1. Run `agentbox accounts check VENDOR/NAME` for each Claude account and fix
   any warning about the transcript store with `agentbox accounts relink`.
   The server refuses the switch when the host's `~/.claude/projects` leads
   to a folder other than the store and holds conversations (run
   `agentbox transcripts adopt`), and when a Claude account's `projects`
   doesn't lead to the store.
1. Run `agentbox accounts mode accounts`.
1. Restart each project container. A container made before the switch is
   stale ("accounts mode host -> accounts") and the server restarts it only
   when it has no sessions or you ask.

To go back, run `agentbox accounts mode host` and restart the containers.

In accounts mode, a box behaves as follows:

- **Account choice**: each box uses one account per vendor. The main session
  uses the account of the box's platform; side sessions use the account of
  their own vendor. A vendor without a choice uses its default account.
  To choose, pass `--account VENDOR/NAME` to `agentbox box new` (repeat it
  for several vendors), use the Account field in the New Box, Edit Box, and
  Fork Conversation dialogs, or run `agentbox box account BOX ACCOUNT`. A
  fork keeps the source box's accounts unless you choose others.
- **Session command**: the server starts each session as
  `env CLAUDE_CONFIG_DIR=ACCOUNT_DIR claude ...` (or `CODEX_HOME`,
  `COPILOT_HOME`), so one container hosts sessions of several accounts.
- **Mounts**: the container mounts `DATA_DIR/accounts` at its host path and
  nothing from `~/.claude`, `~/.codex`, or `~/.copilot`. Each Claude account's
  `sessions` folder is the container's own directory, and the target of any
  link at the top of a Claude account folder (such as `projects`) is mounted
  at its own path. In the container, `~/.claude`, `~/.claude.json`, `~/.codex`,
  and `~/.copilot` link to each vendor's default account.
- **Transcripts**: every Claude account's `projects` link leads to one shared
  store, `DATA_DIR/transcripts/claude` (`~/.claude-box/transcripts/claude`
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
- **Change of account**: a change applies when the box restarts. A Claude box
  resumes its conversation. A Codex or Copilot box starts a new session,
  because the old one stays in the old account's folder.
- **Models**: the model list and the defaults come from the chosen Claude
  account's `.claude.json` and `settings.json`.

## Back up accounts

The account folders hold settings, history, and sign-ins that exist nowhere
else once you use them. Include `DATA_DIR/accounts` in your backups, and
don't delete it when you reinstall Agent Box.

## Move the host's transcripts into the store

`~/.claude-box` is the only folder in your home directory that Agent Box uses
for its own data, so the transcript store lives there. In host mode, the
containers mount the host's `~/.claude`, and its `projects` entry must lead to
the store. A chain of links works, for example
`~/.claude/projects` to another link to `~/.claude-box/transcripts/claude`.
The server follows the whole chain to its real path and mounts each link
path outside `~/.claude`, and the final folder, at the same path in the
container. A link inside `~/.claude` needs no extra mount.

To move an existing `~/.claude/projects` folder, or the folder its link leads
to, into the store, do the following:

1. Stop every box. The command refuses to run while a box runs.
1. Run `agentbox transcripts adopt --dry-run` and read the plan.
1. Run `agentbox transcripts adopt`.

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
