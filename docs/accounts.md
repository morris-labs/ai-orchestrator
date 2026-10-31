# Accounts

An account is one sign-in to an agent CLI: Claude Code, Codex, or GitHub
Copilot. Each account has its own config folder, so you can keep several
accounts of one vendor, such as a personal Claude Max account and a work
Claude Pro account.

This page describes phase 1 of the design in
[Per-account agent config folders](v4/design-accounts.md). In phase 1, you
can create, seed, and check accounts, but boxes still mount the host's own
folders. The `accountsMode` setting stays `host` until phase 2 makes boxes
use accounts.

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
   stay links and aren't followed, so a `projects` link to a shared transcript
   store, such as `~/.claude-projects-shared`, stays a link and duplicates
   nothing. A relative link that points outside the folder becomes absolute,
   so that it still points at the same place. Sockets and pipes are skipped.
1. Leaves out the sign-in files. The copy never opens them.
1. Records the account as not signed in, and makes it the vendor's default
   when the vendor has none.
1. Relabels the vendor's usage history: samples labeled with a legacy name,
   such as the Claude email or `codex-default`, get the account ID, so that
   usage and forecasts carry over.

Seeding also does the following for each vendor:

- **Claude Code**: copies `~/.claude.json` over the copy's own
  `.claude.json`, which is a stale file in `~/.claude`. When `~/.claude/projects`
  is a plain folder rather than a link, the account gets a link to it, so the
  host and every Claude account share one transcript store.
- **Codex**: adds `cli_auth_credentials_store = "file"` to the top of the
  `config.toml` file when the file sets no store, because a container has no
  keyring.

### Sign-in files that seeding leaves out

Seeding leaves out the following files, relative to each host folder:

- Claude Code: `.credentials.json`
- Codex: `auth.json`
- Copilot: `hosts.yml`, `credentials.toml`, and `registered.tokens.json`

The Copilot list isn't verified. Copilot keeps its token in the system
keychain, and the file it falls back to isn't confirmed. Phase 0 of the design
confirms the file names.

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
- To remove an account, run `agentbox accounts remove VENDOR/NAME`. The
  server deletes the record and keeps the folder, which can hold your only
  copy of its settings and history. Delete the folder yourself when you no
  longer need it. The server refuses to remove a vendor's default account.

Replace `TEXT` with the account's display name.

## Back up accounts

The account folders hold settings, history, and sign-ins that exist nowhere
else once you use them. Include `DATA_DIR/accounts` in your backups, and
don't delete it when you reinstall Agent Box.
